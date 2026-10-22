-- SPDX-License-Identifier: Apache-2.0
--
-- A folder's parent, and a note's or file's folder, live in the SAME vault.
-- Every writer already keeps that (tree-ops `resolveParentFolder` refuses a
-- folder from another vault; trash restore, checkpoint revert, MCP and batch
-- creates build the chain inside the one vault they act on), and production
-- holds no row that breaks it. Until now nothing in the schema said so, which
-- is why every recursive folder walk had to range over the whole `folders`
-- table rather than one vault's rows. These constraints make the invariant a
-- fact the queries may rely on (`AND f.vault_id = ...` in each recursive term
-- returns exactly what the unfiltered walk did).
--
-- Additive: one unique index, one composite index, three composite foreign
-- keys. The single-column FKs stay as they are (they own the ON DELETE
-- behaviour that already exists). MATCH SIMPLE: a NULL parent_id / folder_id
-- is not checked, exactly as before.
--
-- The migration runner applies each file inside a transaction, so no
-- CONCURRENTLY, and the ADD's lock is held to COMMIT, so writes to folders,
-- notes and files wait (reads do not) while the indexes build and the FKs
-- validate: a scan of each table, ~100k rows at today's largest.

SET LOCAL lock_timeout = '10s';

-- `id` is the primary key, so this is trivially unique; the FKs need a unique
-- target on exactly (id, vault_id). It also serves a recursive step that
-- carries the vault along (`f.id = c.parent_id AND f.vault_id = c.vault_id`).
CREATE UNIQUE INDEX IF NOT EXISTS folders_id_vault_uq ON folders (id, vault_id);

-- The downward walk (`f.vault_id = $v AND f.parent_id = s.id`) as one probe
-- per working-table row instead of a hash join over every folder.
CREATE INDEX IF NOT EXISTS folders_vault_parent_idx ON folders (vault_id, parent_id);

ALTER TABLE folders
  ADD CONSTRAINT folders_parent_same_vault_fk
  FOREIGN KEY (parent_id, vault_id) REFERENCES folders (id, vault_id)
  ON DELETE CASCADE NOT VALID;
ALTER TABLE folders VALIDATE CONSTRAINT folders_parent_same_vault_fk;

-- SET NULL on the folder column only (PostgreSQL 15+): vault_id is NOT NULL.
ALTER TABLE notes
  ADD CONSTRAINT notes_folder_same_vault_fk
  FOREIGN KEY (folder_id, vault_id) REFERENCES folders (id, vault_id)
  ON DELETE SET NULL (folder_id) NOT VALID;
ALTER TABLE notes VALIDATE CONSTRAINT notes_folder_same_vault_fk;

ALTER TABLE files
  ADD CONSTRAINT files_folder_same_vault_fk
  FOREIGN KEY (folder_id, vault_id) REFERENCES folders (id, vault_id)
  ON DELETE SET NULL (folder_id) NOT VALID;
ALTER TABLE files VALIDATE CONSTRAINT files_folder_same_vault_fk;
