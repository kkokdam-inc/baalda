import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { folderAncestry } from "../src/permissions/resolver.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import { seedFile, seedFolder, seedNote, seedOrg, seedVault } from "./helpers/seed.js";

// `folderAncestry` replaced two `WITH RECURSIVE` walks in the resolver's
// prefetch (prod planned them as a seq scan of every folder per level). It must
// return exactly the rows the recursive form did. Migration 059 then makes the
// same-vault invariant a schema fact, which these tests also pin.

afterAll(async () => {
  await pool.end();
});

/** The pre-change SQL, verbatim in shape, as the oracle. */
async function oldWalk(startIds: string[]): Promise<Array<{ id: string; parent_id: string | null }>> {
  const { rows } = await pool.query<{ id: string; parent_id: string | null }>(
    `WITH RECURSIVE chain AS (
        SELECT id, parent_id FROM folders WHERE id = ANY($1::text[])
        UNION
        SELECT f.id, f.parent_id FROM folders f JOIN chain c ON f.id = c.parent_id
     )
     SELECT id, parent_id FROM chain`,
    [startIds],
  );
  return rows;
}

const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);

describe("folderAncestry", () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function tree() {
    const org = await seedOrg("Org", "ancestry");
    const vault = await seedVault(org);
    const other = await seedVault(org, "Other");
    const a = await seedFolder(vault, null, "A", "A");
    const ab = await seedFolder(vault, a, "B", "A/B");
    const abc = await seedFolder(vault, ab, "C", "A/B/C");
    const abcd = await seedFolder(vault, abc, "D", "A/B/C/D");
    const abce = await seedFolder(vault, abc, "E", "A/B/C/E");
    const x = await seedFolder(vault, null, "X", "X");
    const xy = await seedFolder(vault, x, "Y", "X/Y");
    const o = await seedFolder(other, null, "O", "O");
    const op = await seedFolder(other, o, "P", "O/P");
    return { org, vault, other, a, ab, abc, abcd, abce, x, xy, o, op };
  }

  it("returns the same rows as the recursive walk, from many starts at once", async () => {
    const t = await tree();
    const starts = [t.abcd, t.abce, t.xy, t.op, t.ab, "missing-folder-id"];
    const got = await folderAncestry<{ id: string; parent_id: string | null }>(pool, starts, "f.id, f.parent_id");
    expect([...got].sort(byId)).toEqual((await oldWalk(starts)).sort(byId));
    // Each folder once, even though four starts share A/B/C's ancestors.
    expect(new Set(got.map((r) => r.id)).size).toBe(got.length);
  });

  it("matches for a single deep start, an empty start list and a root", async () => {
    const t = await tree();
    for (const starts of [[t.abcd], [], [t.a]]) {
      const got = await folderAncestry<{ id: string; parent_id: string | null }>(pool, starts, "f.id, f.parent_id");
      expect([...got].sort(byId)).toEqual((await oldWalk(starts)).sort(byId));
    }
  });

  it("ends on a cycle, like the UNION walk", async () => {
    const t = await tree();
    // A ⇄ B: not something a writer makes, but the walk must still terminate.
    await pool.query("UPDATE folders SET parent_id = $2 WHERE id = $1", [t.a, t.ab]);
    const got = await folderAncestry<{ id: string; parent_id: string | null }>(pool, [t.abcd], "f.id, f.parent_id");
    expect([...got].sort(byId)).toEqual((await oldWalk([t.abcd])).sort(byId));
  });
});

describe("migration 059: same-vault folder invariant", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("rejects a folder whose parent is in another vault", async () => {
    const org = await seedOrg("Org", "same-vault-1");
    const v1 = await seedVault(org);
    const v2 = await seedVault(org, "Two");
    const p = await seedFolder(v1, null, "P", "P");
    await expect(seedFolder(v2, p, "C", "P/C")).rejects.toThrow(/folders_parent_same_vault_fk/);
    // Same vault still fine.
    await expect(seedFolder(v1, p, "C", "P/C")).resolves.toBeTruthy();
  });

  it("rejects a note or file whose folder is in another vault, and nulls only folder_id on delete", async () => {
    const org = await seedOrg("Org", "same-vault-2");
    const v1 = await seedVault(org);
    const v2 = await seedVault(org, "Two");
    const p = await seedFolder(v1, null, "P", "P");
    await expect(seedNote(v2, p, "P/n.md")).rejects.toThrow(/notes_folder_same_vault_fk/);
    await expect(seedFile(v2, p, "P/f.png")).rejects.toThrow(/files_folder_same_vault_fk/);

    const n = await seedNote(v1, p, "P/n.md");
    await pool.query("DELETE FROM folders WHERE id = $1", [p]);
    const { rows } = await pool.query("SELECT vault_id, folder_id FROM notes WHERE id = $1", [n]);
    expect(rows[0]).toEqual({ vault_id: v1, folder_id: null });
  });
});
