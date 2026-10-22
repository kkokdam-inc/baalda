import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { recordingAppDeps } from "./helpers/app.js";
import { seedMember, seedNote, seedOrg, seedUser, seedVault, seedVaultGrant } from "./helpers/seed.js";
import { createMcpToken } from "../src/mcp/tokens.js";
import { MCP_RATE_LIMITED } from "../src/http/routes/mcp.js";
import {
  COST_WHOLE_VAULT_LIST,
  TokenBuckets,
  mcpBuckets,
  rateLimitKey,
  resetMcpRateLimit,
  toolCallCost,
} from "../src/mcp/rate-limit.js";
import { snapshot } from "../src/metrics/sync-metrics.js";

/**
 * Per-connection MCP rate limit: a token bucket per token (or OAuth binding),
 * charged per tool call, weighted so a whole-vault listing loop is slowed long
 * before an agent's ordinary reads and edits.
 */

const LIMITS = { perMinute: 120, burst: 60 };

describe("TokenBuckets", () => {
  it("spends a burst, refuses past it, and refills at the sustained rate", () => {
    const b = new TokenBuckets(LIMITS);
    const t0 = 1_000_000;
    for (let i = 0; i < 60; i++) expect(b.take("k", 1, t0).ok).toBe(true);
    const refused = b.take("k", 1, t0);
    expect(refused).toEqual({ ok: false, retryAfterSeconds: 1 });
    // 2 units/s: 10 s later, 20 units.
    for (let i = 0; i < 20; i++) expect(b.take("k", 1, t0 + 10_000).ok).toBe(true);
    expect(b.take("k", 1, t0 + 10_000).ok).toBe(false);
    // Never above the burst, however long idle.
    for (let i = 0; i < 60; i++) expect(b.take("k", 1, t0 + 3_600_000).ok).toBe(true);
    expect(b.take("k", 1, t0 + 3_600_000).ok).toBe(false);
  });

  it("is all or nothing and says how long a larger cost waits", () => {
    const b = new TokenBuckets(LIMITS);
    expect(b.take("k", 50, 0).ok).toBe(true);
    // 10 left; 20 needs 10 more at 2/s = 5 s, and nothing is spent.
    expect(b.take("k", 20, 0)).toEqual({ ok: false, retryAfterSeconds: 5 });
    expect(b.take("k", 10, 0).ok).toBe(true);
  });

  it("keeps keys independent", () => {
    const b = new TokenBuckets(LIMITS);
    expect(b.take("a", 60, 0).ok).toBe(true);
    expect(b.take("a", 1, 0).ok).toBe(false);
    expect(b.take("b", 60, 0).ok).toBe(true);
  });

  it("stays bounded", () => {
    const b = new TokenBuckets(LIMITS);
    for (let i = 0; i < 10_050; i++) b.take(`k${i}`, 1, i);
    expect(b.size).toBeLessThanOrEqual(10_000);
  });

  it("weights whole-vault listings and search, never the paged path", () => {
    expect(toolCallCost("list_notes", { vaultId: "v" })).toBe(COST_WHOLE_VAULT_LIST);
    expect(toolCallCost("list_notes", { vaultId: "v", limit: 200 })).toBe(1);
    expect(toolCallCost("list_notes", { vaultId: "v", cursor: "c" })).toBe(1);
    expect(toolCallCost("list_notes", { vaultId: "v", pathPrefix: "A/" })).toBeGreaterThan(1);
    expect(toolCallCost("search_notes", { vaultId: "v", query: "q" })).toBeGreaterThan(1);
    expect(toolCallCost("read_note", { docId: "d" })).toBe(1);
  });

  it("keys by token row, else by the OAuth binding, never by anything shared", () => {
    expect(rateLimitKey({ userId: "u", organizationId: "o", tokenId: "t1" })).toBe("t:t1");
    const oauth = rateLimitKey({ userId: "u", organizationId: "o", oauthClientId: "c" });
    expect(oauth).not.toBe(rateLimitKey({ userId: "u", organizationId: "o", oauthClientId: "c2" }));
    expect(oauth).not.toBe(rateLimitKey({ userId: "u", organizationId: "o2", oauthClientId: "c" }));
  });
});

const rec = recordingAppDeps();
const app = createApp(rec.deps);

let rpcId = 0;
function msg(name: string, args: Record<string, unknown> = {}) {
  return { jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } };
}
async function post(token: string, body: unknown) {
  return app.fetch(
    new Request("http://local/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
  );
}
const batch = (n: number, name = "list_vaults", args: Record<string, unknown> = {}) =>
  Array.from({ length: n }, () => msg(name, args));

describe("MCP route rate limit", () => {
  let tokenA: string;
  let tokenB: string;
  let vault: string;

  beforeEach(async () => {
    await resetDb();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
    mcpBuckets.configure(LIMITS);
    const owner = await seedUser("owner@ratelimit.test");
    const org = await seedOrg("Rate", "rate-limit");
    await seedMember(org, owner, "owner");
    await seedVaultGrant(org, "edit");
    vault = await seedVault(org);
    await seedNote(vault, null, "a.md", owner);
    ({ token: tokenA } = await createMcpToken({ userId: owner, organizationId: org }, "a"));
    ({ token: tokenB } = await createMcpToken({ userId: owner, organizationId: org }, "b"));
  });
  afterEach(() => {
    vi.useRealTimers();
    resetMcpRateLimit();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("lets an agent's burst through, then answers 429 with Retry-After", async () => {
    // A few dozen ordinary calls in a row are fine.
    for (let i = 0; i < 40; i++) expect((await post(tokenA, msg("list_vaults"))).status).toBe(200);
    expect((await post(tokenA, batch(20))).status).toBe(200);

    const before = snapshot()["mcp.ratelimited"] ?? 0;
    const res = await post(tokenA, msg("list_vaults"));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(MCP_RATE_LIMITED);
    expect(body.error.message).toMatch(/limit and cursor/);
    expect(snapshot()["mcp.ratelimited"]).toBe(before + 1);
  });

  it("refills over time", async () => {
    expect((await post(tokenA, batch(50))).status).toBe(200);
    expect((await post(tokenA, batch(10))).status).toBe(200);
    expect((await post(tokenA, msg("list_vaults"))).status).toBe(429);
    vi.setSystemTime(new Date(Date.now() + 5_000)); // 10 units back
    expect((await post(tokenA, batch(10))).status).toBe(200);
    expect((await post(tokenA, msg("list_vaults"))).status).toBe(429);
    vi.setSystemTime(new Date(Date.now() + 60_000));
    expect((await post(tokenA, batch(50))).status).toBe(200);
  });

  it("keeps a bucket per token", async () => {
    expect((await post(tokenA, batch(50))).status).toBe(200);
    expect((await post(tokenA, batch(10))).status).toBe(200);
    expect((await post(tokenA, msg("list_vaults"))).status).toBe(429);
    expect((await post(tokenB, batch(50))).status).toBe(200);
  });

  it("counts every call in a batch, and a refused batch runs nothing", async () => {
    expect((await post(tokenA, batch(50))).status).toBe(200);
    const refused = await post(tokenA, batch(11, "create_note", { vaultId: vault, relPath: "x.md" }));
    expect(refused.status).toBe(429);
    const errors = (await refused.json()) as Array<{ error: { code: number } }>;
    expect(errors).toHaveLength(11);
    expect(errors.every((e) => e.error.code === MCP_RATE_LIMITED)).toBe(true);
    const { rows } = await pool.query("SELECT 1 FROM notes WHERE vault_id = $1 AND rel_path = 'x.md'", [vault]);
    expect(rows).toEqual([]);
    // The 10 left are still spendable.
    expect((await post(tokenA, batch(10))).status).toBe(200);
  });

  it("slows whole-vault list_notes long before the paged form", async () => {
    let whole = 0;
    while ((await post(tokenA, msg("list_notes", { vaultId: vault }))).status === 200) whole++;
    expect(whole).toBe(Math.floor(LIMITS.burst / COST_WHOLE_VAULT_LIST));

    let paged = 0;
    while ((await post(tokenB, msg("list_notes", { vaultId: vault, limit: 100 }))).status === 200) {
      paged++;
      if (paged > 1000) break;
    }
    expect(paged).toBe(LIMITS.burst);
  });

  it("refuses a batch heavier than the whole bucket", async () => {
    const res = await post(tokenA, batch(4, "list_notes", { vaultId: vault }));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).not.toBeNull();
    // The bucket is untouched: ordinary calls still go through.
    expect((await post(tokenA, batch(50))).status).toBe(200);
  });
});
