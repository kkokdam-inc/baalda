-- SPDX-License-Identifier: Apache-2.0
--
-- The member Activity listing (`GET /orgs/:orgId/members/:userId/activity`,
-- http/routes/members.ts) asks note_versions for
--   WHERE vault_id = ANY($1) AND author_id = $2 AND doc_id = ANY($3)
-- and no index led with either column, so every call read the whole table
-- (the only other index is (doc_id, id DESC), useless with a 2000-id array).
-- The same index serves `ON DELETE SET NULL` on "user" (author_id).
--
-- Additive only. The migration runner applies each file inside a transaction,
-- so this cannot be CREATE INDEX CONCURRENTLY; the build reads note_versions
-- once and blocks new version inserts while it runs (they wait, they do not
-- fail).
SET LOCAL lock_timeout = '10s';

CREATE INDEX IF NOT EXISTS note_versions_author_idx
  ON note_versions (author_id, vault_id, created_at DESC);
