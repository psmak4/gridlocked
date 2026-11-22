ALTER TABLE "legal_documents" DROP CONSTRAINT "legal_documents_kind_check";--> statement-breakpoint
ALTER TABLE "legal_documents" ADD CONSTRAINT "legal_documents_kind_check" CHECK ("legal_documents"."kind" in ('terms', 'privacy', 'community_rules', 'beta'));--> statement-breakpoint
-- The drafts were seeded with the day their migration was written. They have
-- been in force since the first account, and `pendingDocuments` now leaves
-- out a version published after `now` (M9 Task 1), so they're dated from the
-- start of the 2026 season's data instead.
UPDATE "legal_documents" SET "published_at" = '2026-01-01T00:00:00Z' WHERE "version" = 'draft-1';
