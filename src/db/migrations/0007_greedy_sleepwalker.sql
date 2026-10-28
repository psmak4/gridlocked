DROP INDEX "jobs_run_at_pending_idx";--> statement-breakpoint
CREATE INDEX "jobs_run_at_pending_idx" ON "jobs" USING btree ("run_at") WHERE "jobs"."status" in ('pending', 'failed');