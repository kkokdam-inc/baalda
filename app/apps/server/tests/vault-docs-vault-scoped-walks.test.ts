import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  listDeletedReadableDocsInVault,
  listReadableDocsInVault,
  listVisibleFolders,
} from "../src/permissions/vault-docs.js";
import { effectivePermission } from "../src/permissions/resolver.js";
import { pool } from "../src/db/pool.js";
import { resetDb } from "./helpers/db.js";
import {
  sealVault,
  seedDeny,
  seedFolder,
  seedItemPrivate,
  seedMember,
  seedNote,
  seedOrg,
  seedShare,
  seedUser,
  seedVault,
  seedVaultGrant,
} from "./helpers/seed.js";

// Every recursive folder walk in vault-docs.ts now carries `f.vault_id = $vault`
// (safe since migration 059 makes parent and child share a vault). The walks'
// seeds come from org-wide share rows, so an org with TWO vaults, grants and
// denies at several depths in both, is the case where a wrong filter would show:
// each vault's readable set must still agree per doc with effectivePermission,
// and folder visibility must not leak a folder from the other vault.

afterAll(async () => {
  await pool.end();
});

async function deepTree(org: string, vault: string, prefix: string, users: { s: string; m: string }) {
  const a = await seedFolder(vault, null, `${prefix}A`, `${prefix}A`);
  const ab = await seedFolder(vault, a, "B", `${prefix}A/B`);
  const abc = await seedFolder(vault, ab, "C", `${prefix}A/B/C`);
  const abcd = await seedFolder(vault, abc, "D", `${prefix}A/B/C/D`);
  const notes = [
    await seedNote(vault, null, `${prefix}root.md`),
    await seedNote(vault, a, `${prefix}A/a.md`),
    await seedNote(vault, ab, `${prefix}A/B/b.md`, users.m),
    await seedNote(vault, abc, `${prefix}A/B/C/c.md`),
    await seedNote(vault, abcd, `${prefix}A/B/C/D/d.md`),
  ];
  await seedShare(org, "folder", a, users.s, "view");
  await seedDeny(org, "folder", abc, users.s);
  await seedShare(org, "folder", abcd, users.s, "edit");
  await seedItemPrivate(org, "folder", ab);
  await seedDeny(org, "file", notes[1], users.m);
  return { folders: [a, ab, abc, abcd], notes };
}

describe("vault-scoped recursive walks", () => {
  beforeEach(async () => {
    await resetDb();
  });

  for (const posture of ["shared", "private", "sealed"] as const) {
    it(`agrees with effectivePermission in both vaults — ${posture}`, async () => {
      const org = await seedOrg("Org", `walks-${posture}`);
      const owner = await seedUser(`o@${posture}.w`);
      const s = await seedUser(`s@${posture}.w`);
      const m = await seedUser(`m@${posture}.w`);
      await seedMember(org, owner, "owner");
      await seedMember(org, s, "member");
      await seedMember(org, m, "member");
      if (posture === "shared") await seedVaultGrant(org, "edit");
      if (posture === "sealed") await sealVault(org);
      const v1 = await seedVault(org);
      const v2 = await seedVault(org, "Two");
      const t1 = await deepTree(org, v1, "", { s, m });
      const t2 = await deepTree(org, v2, "two-", { s, m });
      await pool.query("UPDATE notes SET deleted_at = now() WHERE id = $1", [t2.notes[4]]);

      for (const [vault, tree, other] of [
        [v1, t1, t2],
        [v2, t2, t1],
      ] as const) {
        for (const u of [owner, s, m]) {
          const set = await listReadableDocsInVault(u, vault);
          for (const d of tree.notes) {
            const eff = await effectivePermission(u, d);
            const live = !(vault === v2 && d === t2.notes[4]);
            expect(set.has(d), `vault=${vault === v1 ? 1 : 2} doc eff=${eff}`).toBe(live && eff !== "none");
          }
          for (const d of other.notes) expect(set.has(d)).toBe(false);
          const deleted = await listDeletedReadableDocsInVault(u, vault);
          for (const d of deleted) expect(vault === v2 && d === t2.notes[4]).toBe(true);
          const visible = await listVisibleFolders(u, vault);
          const visibleIds = new Set(visible.map((f) => f.id));
          for (const f of other.folders) expect(visibleIds.has(f)).toBe(false);
        }
      }
    });
  }
});
