import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { recordingAppDeps } from "./helpers/app.js";
import {
  seedFolder,
  seedMember,
  seedNote,
  seedOrg,
  seedShare,
  seedUser,
  seedVault,
  seedVaultGrant,
} from "./helpers/seed.js";
import { createMcpToken } from "../src/mcp/tokens.js";

/**
 * MCP response size: the text block is compact JSON carrying exactly the
 * structuredContent's data, and `list_notes` pages on request while its
 * no-argument call still returns every note as before.
 */

const rec = recordingAppDeps();
const app = createApp(rec.deps);

let rpcId = 0;
async function call(token: string, name: string, args: Record<string, unknown> = {}) {
  const res = await app.fetch(
    new Request("http://local/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: ++rpcId,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
  );
  const body = (await res.json()) as {
    result?: { structuredContent?: unknown; isError?: boolean; content?: Array<{ text: string }> };
  };
  return {
    isError: body.result?.isError ?? false,
    data: body.result?.structuredContent as any,
    text: body.result?.content?.[0]?.text ?? "",
  };
}

async function tokenFor(userId: string, orgId: string): Promise<string> {
  const { token } = await createMcpToken({ userId, organizationId: orgId }, "test");
  return token;
}

type Listed = { docId: string; relPath: string; permission: string };

/** Walk every page; fails on a page over `limit` or a runaway loop. */
async function pageAll(token: string, args: Record<string, unknown>, limit: number) {
  const seen: Listed[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 1000; i++) {
    const page = await call(token, "list_notes", { ...args, limit, ...(cursor ? { cursor } : {}) });
    expect(page.isError).toBe(false);
    expect(page.data.results.length).toBeLessThanOrEqual(limit);
    seen.push(...page.data.results);
    if (page.data.nextCursor === null) {
      return seen;
    }
    // A non-final page is always full.
    expect(page.data.results).toHaveLength(limit);
    cursor = page.data.nextCursor;
  }
  throw new Error("pagination never ended");
}

describe("MCP payload size", () => {
  beforeEach(async () => {
    await resetDb();
  });
  afterAll(async () => {
    await pool.end();
  });

  it("sends compact text that parses to the structuredContent data", async () => {
    const owner = await seedUser("owner@payload.test");
    const org = await seedOrg("Payload", "payload-compact");
    await seedMember(org, owner, "owner");
    const vault = await seedVault(org);
    await seedVaultGrant(org, "edit");
    await seedFolder(vault, null, "Docs", "Docs", owner);
    for (const p of ["a.md", "Docs/b.md"]) await seedNote(vault, null, p, owner);
    const token = await tokenFor(owner, org);

    for (const [name, args] of [
      ["list_vaults", {}],
      ["list_folders", { vaultId: vault }],
      ["list_notes", { vaultId: vault }],
      ["list_notes", { vaultId: vault, limit: 1 }],
    ] as const) {
      const r = await call(token, name, args);
      expect(r.isError).toBe(false);
      // No indentation or line breaks: one compact JSON value.
      expect(r.text).not.toMatch(/\n/);
      expect(r.text).toBe(JSON.stringify(JSON.parse(r.text)));
      const parsed = JSON.parse(r.text);
      // Arrays are wrapped as { results } in structuredContent; objects match as-is.
      expect(Array.isArray(parsed) ? { results: parsed } : parsed).toEqual(r.data);
    }
  });

  it("returns every note as a bare list when no limit or cursor is given", async () => {
    const owner = await seedUser("owner@payload.test");
    const org = await seedOrg("Payload", "payload-default");
    await seedMember(org, owner, "owner");
    const vault = await seedVault(org);
    await seedVaultGrant(org, "edit");
    const paths = Array.from({ length: 30 }, (_, i) => `n${String(i).padStart(2, "0")}.md`);
    for (const p of paths) await seedNote(vault, null, p, owner);
    const token = await tokenFor(owner, org);

    const r = await call(token, "list_notes", { vaultId: vault });
    expect(r.isError).toBe(false);
    expect(Array.isArray(JSON.parse(r.text))).toBe(true);
    expect(r.data.nextCursor).toBeUndefined();
    expect(r.data.results.map((n: Listed) => n.relPath)).toEqual(paths);
  });

  it("pages through every readable note with no duplicates or gaps", async () => {
    const owner = await seedUser("owner@payload.test");
    const member = await seedUser("member@payload.test");
    const org = await seedOrg("Payload", "payload-pages");
    await seedMember(org, owner, "owner");
    await seedMember(org, member, "member");
    // Never shared: the member reads only the folder shared with them.
    const vault = await seedVault(org);
    const shared = await seedFolder(vault, null, "Shared", "Shared", owner);
    const hidden = await seedFolder(vault, null, "Hidden", "Hidden", owner);
    await seedShare(org, "folder", shared, member, "view");
    // Interleave hidden and visible notes so pages must read past hidden rows.
    for (let i = 0; i < 23; i++) {
      const n = String(i).padStart(2, "0");
      await seedNote(vault, shared, `Shared/${n}.md`, owner);
      await seedNote(vault, hidden, `Hidden/${n}.md`, owner);
    }
    await seedNote(vault, null, "root.md", owner);

    for (const [userId, limit] of [
      [owner, 1],
      [owner, 7],
      [owner, 47],
      [owner, 100],
      [member, 4],
      [member, 23],
    ] as const) {
      const token = await tokenFor(userId, org);
      const all = (await call(token, "list_notes", { vaultId: vault })).data.results as Listed[];
      const paged = await pageAll(token, { vaultId: vault }, limit);
      expect(new Set(paged.map((n) => n.docId)).size).toBe(paged.length);
      expect(paged.map((n) => n.docId).sort()).toEqual(all.map((n) => n.docId).sort());
      expect(paged.map((n) => n.permission).sort()).toEqual(all.map((n) => n.permission).sort());
    }
    const memberAll = await call(await tokenFor(member, org), "list_notes", { vaultId: vault });
    expect(memberAll.data.results).toHaveLength(23);
  });

  it("filters by path prefix and folder, paged or not", async () => {
    const owner = await seedUser("owner@payload.test");
    const org = await seedOrg("Payload", "payload-prefix");
    await seedMember(org, owner, "owner");
    const vault = await seedVault(org);
    await seedVaultGrant(org, "edit");
    const projects = await seedFolder(vault, null, "Projects", "Projects", owner);
    for (let i = 0; i < 5; i++) await seedNote(vault, projects, `Projects/p${i}.md`, owner);
    await seedNote(vault, null, "ProjectsIndex.md", owner);
    await seedNote(vault, null, "other.md", owner);
    const token = await tokenFor(owner, org);

    const byPrefix = await call(token, "list_notes", { vaultId: vault, pathPrefix: "Projects/" });
    expect(byPrefix.data.results.map((n: Listed) => n.relPath)).toEqual(
      [0, 1, 2, 3, 4].map((i) => `Projects/p${i}.md`),
    );
    const pagedPrefix = await pageAll(token, { vaultId: vault, pathPrefix: "Projects/" }, 2);
    expect(pagedPrefix.map((n) => n.relPath)).toEqual(
      byPrefix.data.results.map((n: Listed) => n.relPath),
    );
    const pagedFolder = await pageAll(token, { vaultId: vault, folderId: projects }, 3);
    expect(pagedFolder).toHaveLength(5);
  });

  it("refuses a bad limit or cursor", async () => {
    const owner = await seedUser("owner@payload.test");
    const org = await seedOrg("Payload", "payload-bad");
    await seedMember(org, owner, "owner");
    const vault = await seedVault(org);
    const token = await tokenFor(owner, org);
    expect((await call(token, "list_notes", { vaultId: vault, limit: 0 })).isError).toBe(true);
    expect((await call(token, "list_notes", { vaultId: vault, limit: 1.5 })).isError).toBe(true);
    expect((await call(token, "list_notes", { vaultId: vault, cursor: "nope" })).isError).toBe(true);
  });
});
