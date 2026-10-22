import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  listDeletedReadableDocsInVault,
  listReadableDocsInVault,
  type SharedVaultReads,
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
  seedUserVaultGrant,
  seedVault,
  seedVaultGrant,
} from "./helpers/seed.js";

// The vault channel now hands several users' readable-set computations for ONE
// message a shared memo of the user-independent reads (the vault's whole doc
// list, the team's item denies, the org posture). Sharing must change nothing:
// every user's set with a memo shared across ALL of them equals the set computed
// alone, and both agree per doc with effectivePermission.

afterAll(async () => {
  await pool.end();
});

/** A 4-deep tree with grants and denies at several depths, for both principals. */
async function seedTree(org: string, vault: string, users: Record<string, string>) {
  const a = await seedFolder(vault, null, "A", "A");
  const ab = await seedFolder(vault, a, "B", "A/B");
  const abc = await seedFolder(vault, ab, "C", "A/B/C");
  const abcd = await seedFolder(vault, abc, "D", "A/B/C/D");
  const x = await seedFolder(vault, null, "X", "X");
  const notes = [
    await seedNote(vault, null, "root.md", users.member),
    await seedNote(vault, a, "A/a.md"),
    await seedNote(vault, ab, "A/B/b.md", users.member),
    await seedNote(vault, abc, "A/B/C/c.md"),
    await seedNote(vault, abcd, "A/B/C/D/d.md"),
    await seedNote(vault, abcd, "A/B/C/D/d2.md"),
    await seedNote(vault, x, "X/x.md"),
  ];
  // Per-user grant high, per-user deny deeper, per-user grant deeper still.
  await seedShare(org, "folder", a, users.scoped, "view");
  await seedDeny(org, "folder", abc, users.scoped);
  await seedShare(org, "file", notes[4], users.scoped, "edit");
  // Team item-Private on a subtree, rescued by name for one user.
  await seedItemPrivate(org, "folder", ab);
  await seedShare(org, "file", notes[3], users.named, "view");
  // A per-user deny on one file for a plain member.
  await seedDeny(org, "file", notes[5], users.member);
  // Org grant on one folder.
  await pool.query(
    `INSERT INTO shares (id, org_id, resource_type, resource_id, principal_type, principal_id, permission)
     VALUES (gen_random_uuid()::text, $1, 'folder', $2, 'org', $1, 'view')`,
    [org, x],
  );
  return notes;
}

async function checkAll(vault: string, userIds: string[], docs: string[]) {
  const memo: SharedVaultReads = new Map();
  const shared = await Promise.all(userIds.map((u) => listReadableDocsInVault(u, vault, pool, memo)));
  for (const [i, u] of userIds.entries()) {
    const alone = await listReadableDocsInVault(u, vault);
    expect(shared[i], `user ${i} shared vs alone`).toEqual(alone);
    for (const d of docs) {
      const eff = await effectivePermission(u, d);
      expect(alone.has(d), `user ${i} doc ${d} eff=${eff}`).toBe(eff !== "none");
    }
  }
  // The shared sets are independent copies: editing one never reaches another.
  for (const s of shared) s.clear();
  const again = await Promise.all(userIds.map((u) => listReadableDocsInVault(u, vault, pool, memo)));
  for (const [i, u] of userIds.entries()) {
    expect(again[i]).toEqual(await listReadableDocsInVault(u, vault));
  }
  return memo;
}

describe("listReadableDocsInVault with a shared per-message memo", () => {
  beforeEach(async () => {
    await resetDb();
  });

  async function setup(slug: string) {
    const org = await seedOrg("Org", slug);
    const users = {
      owner: await seedUser(`o@${slug}.com`),
      admin: await seedUser(`a@${slug}.com`),
      member: await seedUser(`m@${slug}.com`),
      scoped: await seedUser(`s@${slug}.com`),
      named: await seedUser(`n@${slug}.com`),
      personal: await seedUser(`p@${slug}.com`),
      outsider: await seedUser(`x@${slug}.com`),
    };
    await seedMember(org, users.owner, "owner");
    await seedMember(org, users.admin, "admin");
    for (const u of [users.member, users.scoped, users.named, users.personal]) await seedMember(org, u, "member");
    const vault = await seedVault(org);
    const docs = await seedTree(org, vault, users);
    return { org, vault, users, docs };
  }

  it("Shared vault: identical sets and resolver agreement for every user", async () => {
    const { org, vault, users, docs } = await setup("sr-shared");
    await seedVaultGrant(org, "edit");
    await seedUserVaultGrant(org, users.personal, "view");
    const memo = await checkAll(vault, Object.values(users), docs);
    // The user-independent reads really were shared.
    expect([...memo.keys()].some((k) => k.startsWith("all\u0000"))).toBe(true);
  });

  it("never-shared (private-by-default) vault", async () => {
    const { vault, users, docs } = await setup("sr-private");
    await checkAll(vault, Object.values(users), docs);
  });

  it("sealed vault", async () => {
    const { org, vault, users, docs } = await setup("sr-sealed");
    await sealVault(org);
    await seedUserVaultGrant(org, users.personal, "edit");
    await checkAll(vault, Object.values(users), docs);
  });

  it("private join snapshot", async () => {
    const { org, vault, users, docs } = await setup("sr-snapshot");
    await seedVaultGrant(org, "edit");
    // Everything above existed when `member` joined under a Private default.
    await pool.query(
      `INSERT INTO member_access_snapshots (organization_id, user_id, mode, access_revision, snapshot_at)
       VALUES ($1, $2, 'private', 0, now() + interval '1 day')
       ON CONFLICT (organization_id, user_id)
         DO UPDATE SET mode = 'private', access_revision = 0, snapshot_at = now() + interval '1 day'`,
      [org, users.member],
    );
    await checkAll(vault, Object.values(users), docs);
  });

  it("deleted set is unchanged (it takes no memo)", async () => {
    const { org, vault, users, docs } = await setup("sr-deleted");
    await seedVaultGrant(org, "edit");
    await pool.query("UPDATE notes SET deleted_at = now() WHERE id = ANY($1::text[])", [docs.slice(0, 3)]);
    for (const u of Object.values(users)) {
      const del = await listDeletedReadableDocsInVault(u, vault);
      for (const d of del) expect(docs.slice(0, 3)).toContain(d);
    }
    await checkAll(vault, Object.values(users), docs.slice(3));
  });
});
