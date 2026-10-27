-- SPDX-License-Identifier: Apache-2.0
--
-- tokenize() now keeps Unicode word runs (Hangul, CJK, accented Latin), not just
-- [a-z0-9_]. Vectors stored before that were built from ASCII tokens only, so a
-- Korean query could hash into a bucket an old ASCII-only vector happens to use
-- and outrank the note that actually contains the word. Both tables are a
-- rebuildable cache:
--  - note_index: age every row so the boot-time backfillIndex() re-embeds each
--    live note from its stored state (stale = ni.updated_at < notes.updated_at).
--  - blob_text: drop the stale vector; keyword matching still ranks the file and
--    the next text upload stores a fresh vector.
UPDATE note_index SET updated_at = to_timestamp(0);
UPDATE blob_text SET vector = NULL WHERE vector IS NOT NULL;
