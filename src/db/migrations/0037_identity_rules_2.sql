-- The first draft of each legal document (DM 6.8). "draft-1" is a placeholder
-- until the lawyer's text is published; the pages live at these urls.
-- A later version is a new row, with requires_reacceptance when users must
-- agree again.
INSERT INTO "legal_documents" ("id", "kind", "version", "published_at", "requires_reacceptance", "url")
VALUES
  (gen_random_uuid(), 'terms', 'draft-1', '2026-11-08T00:00:00Z', false, '/legal/terms'),
  (gen_random_uuid(), 'privacy', 'draft-1', '2026-11-08T00:00:00Z', false, '/legal/privacy'),
  (gen_random_uuid(), 'community_rules', 'draft-1', '2026-11-08T00:00:00Z', false, '/legal/community_rules');
