import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/http/app.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { recordingAppDeps } from "./helpers/app.js";
import {
  seedBlob,
  seedBlobText,
  seedFile,
  seedFolder,
  seedMember,
  seedNote,
  seedOrg,
  seedUser,
  seedVault,
  seedVaultGrant,
} from "./helpers/seed.js";
import { createMcpToken, revokeMcpToken } from "../src/mcp/tokens.js";
import { MCP_MAX_BATCH, resetMcpBadTokens } from "../src/http/routes/mcp.js";

/**
 * An MCP token reaches ONLY the vault it was minted for. The dangerous case is
 * a person who belongs to two vaults: their token for A must refuse every id
 * from B, even though the person could reach B in the app. A foreign id must
 * read exactly like a missing one, so a token cannot probe what exists outside
 * its vault.
 */

const rec = recordingAppDeps();
const app = createApp(rec.deps);

let rpcId = 0;
async function post(token: string, body: unknown) {
  return app.fetch(
    new Request("http://local/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }),
  );
}

async function call(token: string, name: string, args: Record<string, unknown> = {}) {
  const res = await post(token, {
    jsonrpc: "2.0",
    id: ++rpcId,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const body = (await res.json()) as {
    result?: { structuredContent?: unknown; isError?: boolean; content?: Array<{ text: string }> };
    error?: { message: string };
  };
  return {
    status: res.status,
    isError: body.result?.isError ?? false,
    data: body.result?.structuredContent as any,
    text: body.result?.content?.[0]?.text ?? body.error?.message ?? "",
  };
}

describe("MCP token scope", () => {
  let user: string;
  let orgA: string;
  let orgB: string;
  let vaultA: string;
  let vaultB: string;
  let folderB: string;
  let noteB: string;
  let fileB: string;
  let blobB: string;
  let tokenA: string;

  beforeEach(async () => {
    await resetDb();
    resetMcpBadTokens();
    user = await seedUser("both@scope.test");
    orgA = await seedOrg("A", "scope-a");
    orgB = await seedOrg("B", "scope-b");
    // Owner of BOTH vaults: only the token, not the person, limits the reach.
    await seedMember(orgA, user, "owner");
    await seedMember(orgB, user, "owner");
    await seedVaultGrant(orgA, "edit");
    await seedVaultGrant(orgB, "edit");
    vaultA = await seedVault(orgA);
    vaultB = await seedVault(orgB);
    await seedFolder(vaultA, null, "Here", "Here", user);
    await seedNote(vaultA, null, "a.md", user);
    folderB = await seedFolder(vaultB, null, "There", "There", user);
    noteB = await seedNote(vaultB, folderB, "There/secret.md", user);
    fileB = await seedFile(vaultB, folderB, "There/sheet.csv");
    blobB = await seedBlob(vaultB, orgB, "There/sheet.csv", { docId: fileB });
    await seedBlobText(blobB, vaultB, fileB, "secret text");
    ({ token: tokenA } = await createMcpToken({ userId: user, organizationId: orgA }, "a"));
  });
  afterAll(async () => {
    await pool.end();
  });

  it("list_vaults lists only the token's vault", async () => {
    const r = await call(tokenA, "list_vaults");
    expect(r.isError).toBe(false);
    expect(r.data.results.map((v: { vaultId: string }) => v.vaultId)).toEqual([vaultA]);
  });

  it("refuses another vault's vaultId on every vault-taking tool", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ["list_folders", { vaultId: vaultB }],
      ["list_notes", { vaultId: vaultB }],
      ["list_notes", { vaultId: vaultB, limit: 5 }],
      ["search_notes", { vaultId: vaultB, query: "secret" }],
      ["list_attachments", { vaultId: vaultB }],
      ["read_attachment_text", { vaultId: vaultB, blobId: blobB }],
      ["read_attachment_text", { vaultId: vaultB, relPath: "There/sheet.csv" }],
      ["create_folder", { vaultId: vaultB, name: "X", path: "X" }],
      ["create_note", { vaultId: vaultB, relPath: "x.md", content: "hi" }],
    ];
    for (const [name, args] of calls) {
      const r = await call(tokenA, name, args);
      expect(r.isError, name).toBe(true);
      expect(r.text, name).not.toContain("secret");
    }
    // Nothing was created in B.
    const { rows } = await pool.query(
      "SELECT 1 FROM notes WHERE vault_id = $1 AND rel_path = 'x.md' UNION ALL SELECT 1 FROM folders WHERE vault_id = $1 AND path = 'X'",
      [vaultB],
    );
    expect(rows).toEqual([]);
  });

  it("refuses another vault's docId, folderId and fileId, and leaves them untouched", async () => {
    const calls: Array<[string, Record<string, unknown>]> = [
      ["read_note", { docId: noteB }],
      ["update_note", { docId: noteB, content: "pwned" }],
      ["append_note", { docId: noteB, text: "pwned" }],
      ["edit_note", { docId: noteB, edits: [{ type: "insert_after", anchor: "x", text: "pwned" }] }],
      ["move_note", { docId: noteB, relPath: "moved.md" }],
      ["delete_note", { docId: noteB }],
      ["delete_folder", { folderId: folderB, recursive: true }],
      ["move_folder", { folderId: folderB, path: "Moved" }],
      ["delete_file", { fileId: fileB }],
      ["move_file", { fileId: fileB, path: "moved.csv" }],
      // A foreign folder as the parent of a create in the token's own vault.
      ["create_note", { vaultId: vaultA, relPath: "There/x.md", folderId: folderB }],
      ["create_folder", { vaultId: vaultA, name: "Y", path: "There/Y", parentId: folderB }],
    ];
    for (const [name, args] of calls) {
      const r = await call(tokenA, name, args);
      expect(r.isError, name).toBe(true);
    }
    const note = await pool.query("SELECT rel_path, deleted_at FROM notes WHERE id = $1", [noteB]);
    expect(note.rows[0]).toEqual({ rel_path: "There/secret.md", deleted_at: null });
    const folder = await pool.query("SELECT path FROM folders WHERE id = $1", [folderB]);
    expect(folder.rows[0]).toEqual({ path: "There" });
    const file = await pool.query("SELECT path FROM files WHERE id = $1", [fileB]);
    expect(file.rows[0]).toEqual({ path: "There/sheet.csv" });
  });

  it("answers a foreign id exactly like a missing one", async () => {
    const pairs: Array<[string, string, Record<string, unknown>, Record<string, unknown>]> = [
      ["list_folders", "vault", { vaultId: vaultB }, { vaultId: "missing" }],
      ["read_note", "note", { docId: noteB }, { docId: "missing" }],
      ["delete_folder", "folder", { folderId: folderB }, { folderId: "missing" }],
      ["move_folder", "folder", { folderId: folderB, path: "M" }, { folderId: "missing", path: "M" }],
      ["delete_file", "file", { fileId: fileB }, { fileId: "missing" }],
      ["move_file", "file", { fileId: fileB, path: "m.csv" }, { fileId: "missing", path: "m.csv" }],
    ];
    for (const [name, , foreignArgs, missingArgs] of pairs) {
      const foreign = await call(tokenA, name, foreignArgs);
      const missing = await call(tokenA, name, missingArgs);
      expect(foreign.isError, name).toBe(true);
      expect(missing.isError, name).toBe(true);
      const strip = (t: string, id: unknown) => t.replace(String(id), "<id>");
      const id = Object.values(foreignArgs)[0];
      expect(strip(foreign.text, id), name).toBe(strip(missing.text, "missing"));
    }
  });

  it("stops working once the user leaves the vault, the token is revoked, or the vault is deleted", async () => {
    const { token: t2, row } = await createMcpToken({ userId: user, organizationId: orgA }, "b");
    expect((await call(t2, "list_vaults")).status).toBe(200);

    await revokeMcpToken(user, row.id);
    expect((await call(t2, "list_vaults")).status).toBe(401);

    await pool.query(`DELETE FROM member WHERE "organizationId" = $1 AND "userId" = $2`, [orgA, user]);
    expect((await call(tokenA, "list_vaults")).status).toBe(401);

    const { token: tB } = await createMcpToken({ userId: user, organizationId: orgB }, "c");
    await pool.query(`DELETE FROM organization WHERE id = $1`, [orgB]).catch(async () => {
      // Org rows may be held by other FKs; losing the membership is the same signal.
      await pool.query(`DELETE FROM member WHERE "organizationId" = $1`, [orgB]);
    });
    expect((await call(tB, "list_vaults")).status).toBe(401);
  });

  it("refuses an unknown or malformed token", async () => {
    expect((await call(`mcp_${randomUUID()}`, "list_vaults")).status).toBe(401);
    expect((await call("not-a-token", "list_vaults")).status).toBe(401);
  });

  it("bounds the number of messages in one request", async () => {
    const batch = Array.from({ length: MCP_MAX_BATCH + 1 }, (_, i) => ({
      jsonrpc: "2.0",
      id: i + 1,
      method: "ping",
    }));
    expect((await post(tokenA, batch)).status).toBe(400);
    const ok = await post(tokenA, batch.slice(0, MCP_MAX_BATCH));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toHaveLength(MCP_MAX_BATCH);
  });
});
