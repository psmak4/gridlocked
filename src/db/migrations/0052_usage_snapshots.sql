CREATE TABLE "usage_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"taken_at" timestamp with time zone NOT NULL,
	"neon_compute_hours" double precision NOT NULL,
	"neon_transfer_gb" double precision NOT NULL,
	"vercel_cpu_hours" double precision,
	"limits" jsonb NOT NULL
);
--> statement-breakpoint
CREATE INDEX "usage_snapshots_taken_at_idx" ON "usage_snapshots" USING btree ("taken_at");