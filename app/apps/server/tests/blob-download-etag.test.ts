import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/http/app.js";
import { testAppDeps } from "./helpers/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { signUp } from "./helpers/auth.js";
import { seedMember, seedOrg, seedVault, seedVaultGrant } from "./helpers/seed.js";

const app = createApp(testAppDeps());

afterAll(async () => {
  await pool.end();
});

function download(token: string, id: string, extra: Record<string, string> = {}) {
  return app.fetch(
    new Request(`http://local/api/blobs/${id}`, {
      headers: { authorization: `Bearer ${token}`, ...extra },
    }),
  );
}

describe("blob download caching headers", () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function setup() {
    const owner = await signUp("owner@etag.com");
    const org = await seedOrg("Acme", "acme-etag");
    await seedMember(org, owner.userId, "owner");
    const vault = await seedVault(org);
    // New vaults are shared with their team; an unshared one withdraws the
    // owner shortcut, and attachment reads need vault-wide access.
    await seedVaultGrant(org, "edit");
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const up = await app.fetch(
      new Request(`http://local/api/vaults/${vault}/blobs`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${owner.token}`,
          "content-type": "application/octet-stream",
          "x-rel-path": "attachments/etag.bin",
        },
        body: bytes,
      }),
    );
    expect(up.status).toBe(201);
    const { id } = (await up.json()) as { id: string };
    const sha = createHash("sha256").update(bytes).digest("hex");
    return { owner, id, sha };
  }

  it("200 carries ETag and immutable Cache-Control", async () => {
    const { owner, id, sha } = await setup();
    const res = await download(owner.token, id);
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe(`"${sha}"`);
    expect(res.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
  });

  it("matching If-None-Match answers 304 with no body", async () => {
    const { owner, id, sha } = await setup();
    for (const inm of [`"${sha}"`, `W/"${sha}"`, `"other", "${sha}"`, "*"]) {
      const res = await download(owner.token, id, { "if-none-match": inm });
      expect(res.status).toBe(304);
      expect(res.headers.get("etag")).toBe(`"${sha}"`);
      expect(await res.text()).toBe("");
    }
    const miss = await download(owner.token, id, { "if-none-match": '"nope"' });
    expect(miss.status).toBe(200);
  });

  it("a caller without access still gets 403 with a matching If-None-Match", async () => {
    const { id, sha } = await setup();
    const stranger = await signUp("stranger@etag.com");
    const res = await download(stranger.token, id, { "if-none-match": `"${sha}"` });
    expect(res.status).toBe(403);
    expect(res.headers.get("etag")).toBeNull();
  });
});
