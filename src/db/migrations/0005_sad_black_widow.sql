CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer NOT NULL,
	"locked_until" timestamp with time zone,
	"last_error" text,
	"parent_job_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "jobs_kind_dedupe_key_unique" UNIQUE("kind","dedupe_key"),
	CONSTRAINT "jobs_status_check" CHECK ("jobs"."status" in ('pending', 'running', 'succeeded', 'failed', 'dead'))
);
--> statement-breakpoint
CREATE TABLE "provider_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"endpoint" text NOT NULL,
	"params" jsonb NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"status_code" integer,
	"duration_ms" integer NOT NULL,
	"outcome" text NOT NULL,
	"snapshot_id" uuid,
	"error" text,
	"job_id" uuid,
	CONSTRAINT "provider_requests_outcome_check" CHECK ("provider_requests"."outcome" in ('new_snapshot', 'unchanged', 'error', 'rate_limited'))
);
--> statement-breakpoint
CREATE TABLE "raw_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"endpoint" text NOT NULL,
	"params_hash" text NOT NULL,
	"content_hash" text NOT NULL,
	"body" jsonb NOT NULL,
	"body_bytes" integer NOT NULL,
	"first_fetched_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"season_id" uuid,
	"event_id" uuid,
	"session_id" uuid,
	CONSTRAINT "raw_snapshots_params_hash_content_hash_unique" UNIQUE("params_hash","content_hash")
);
--> statement-breakpoint
CREATE TABLE "result_changes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"driver_id" uuid NOT NULL,
	"field" text NOT NULL,
	"old_value" text,
	"new_value" text,
	"from_snapshot_id" uuid NOT NULL,
	"to_snapshot_id" uuid NOT NULL,
	"detected_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "result_overrides" (
	"id" uuid PRIMARY KEY NOT NULL,
	"session_id" uuid NOT NULL,
	"driver_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "result_overrides_kind_check" CHECK ("result_overrides"."kind" in ('patch', 'insert', 'suppress')),
	CONSTRAINT "result_overrides_fields_object_check" CHECK (jsonb_typeof("result_overrides"."fields") = 'object'),
	CONSTRAINT "result_overrides_insert_fields_check" CHECK ("result_overrides"."kind" <> 'insert' or "result_overrides"."fields" ?& array['constructor_id', 'car_number', 'classification', 'provider_status', 'provider_position_text']),
	CONSTRAINT "result_overrides_fields_not_empty_check" CHECK ("result_overrides"."kind" = 'suppress' or "result_overrides"."fields" <> '{}'::jsonb)
);
--> statement-breakpoint
CREATE TABLE "results" (
	"session_id" uuid NOT NULL,
	"driver_id" uuid NOT NULL,
	"constructor_id" uuid NOT NULL,
	"snapshot_id" uuid NOT NULL,
	"session_kind" text DEFAULT 'unset' NOT NULL,
	"car_number" integer NOT NULL,
	"position" integer,
	"classification" text NOT NULL,
	"provider_status" text NOT NULL,
	"provider_position_text" text NOT NULL,
	"grid" integer,
	"pit_lane_start" boolean DEFAULT false NOT NULL,
	"laps" integer,
	"time_ms" bigint,
	"fastest_lap_rank" integer,
	"fastest_lap_ms" integer,
	"q1_ms" integer,
	"q2_ms" integer,
	"q3_ms" integer,
	"official_points" numeric(4, 1),
	CONSTRAINT "results_pkey" PRIMARY KEY("session_id","driver_id"),
	CONSTRAINT "results_session_kind_check" CHECK ("results"."session_kind" in ('fp1', 'fp2', 'fp3', 'sprint_qualifying', 'sprint', 'qualifying', 'race')),
	CONSTRAINT "results_classification_check" CHECK ("results"."classification" in ('classified', 'not_classified', 'disqualified', 'did_not_start', 'did_not_qualify', 'excluded')),
	CONSTRAINT "results_grid_sprint_race_only_check" CHECK ("results"."session_kind" in ('sprint', 'race') or ("results"."grid" is null and "results"."pit_lane_start" = false)),
	CONSTRAINT "results_pit_lane_start_grid_check" CHECK ("results"."pit_lane_start" = false or "results"."grid" is null),
	CONSTRAINT "results_q_times_qualifying_only_check" CHECK ("results"."session_kind" in ('qualifying', 'sprint_qualifying') or ("results"."q1_ms" is null and "results"."q2_ms" is null and "results"."q3_ms" is null))
);
--> statement-breakpoint
CREATE TABLE "review_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"season_id" uuid,
	"event_id" uuid,
	"session_id" uuid,
	"driver_id" uuid,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolution" text,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"dedupe_key" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "review_items_severity_check" CHECK ("review_items"."severity" in ('blocking', 'warning')),
	CONSTRAINT "review_items_status_check" CHECK ("review_items"."status" in ('open', 'resolved', 'dismissed'))
);
--> statement-breakpoint
CREATE TABLE "session_participants" (
	"session_id" uuid NOT NULL,
	"driver_id" uuid NOT NULL,
	"constructor_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"snapshot_id" uuid NOT NULL,
	CONSTRAINT "session_participants_pkey" PRIMARY KEY("session_id","driver_id")
);
--> statement-breakpoint
CREATE TABLE "session_result_state" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'awaiting' NOT NULL,
	"source" text DEFAULT 'provider' NOT NULL,
	"current_snapshot_id" uuid,
	"poll_attempts" integer DEFAULT 0 NOT NULL,
	"next_poll_at" timestamp with time zone,
	"gave_up_at" timestamp with time zone,
	"finalized_at" timestamp with time zone,
	"reopened_count" integer DEFAULT 0 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "session_result_state_status_check" CHECK ("session_result_state"."status" in ('awaiting', 'provisional', 'under_review', 'final')),
	CONSTRAINT "session_result_state_source_check" CHECK ("session_result_state"."source" in ('provider', 'manual'))
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_parent_job_id_jobs_id_fk" FOREIGN KEY ("parent_job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_requests" ADD CONSTRAINT "provider_requests_snapshot_id_raw_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."raw_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_requests" ADD CONSTRAINT "provider_requests_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_snapshots" ADD CONSTRAINT "raw_snapshots_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_snapshots" ADD CONSTRAINT "raw_snapshots_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_snapshots" ADD CONSTRAINT "raw_snapshots_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result_changes" ADD CONSTRAINT "result_changes_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result_changes" ADD CONSTRAINT "result_changes_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result_changes" ADD CONSTRAINT "result_changes_from_snapshot_id_raw_snapshots_id_fk" FOREIGN KEY ("from_snapshot_id") REFERENCES "public"."raw_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result_changes" ADD CONSTRAINT "result_changes_to_snapshot_id_raw_snapshots_id_fk" FOREIGN KEY ("to_snapshot_id") REFERENCES "public"."raw_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result_overrides" ADD CONSTRAINT "result_overrides_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "result_overrides" ADD CONSTRAINT "result_overrides_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "results" ADD CONSTRAINT "results_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "results" ADD CONSTRAINT "results_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "results" ADD CONSTRAINT "results_constructor_id_constructors_id_fk" FOREIGN KEY ("constructor_id") REFERENCES "public"."constructors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "results" ADD CONSTRAINT "results_snapshot_id_raw_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."raw_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_items" ADD CONSTRAINT "review_items_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_participants" ADD CONSTRAINT "session_participants_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_participants" ADD CONSTRAINT "session_participants_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_participants" ADD CONSTRAINT "session_participants_constructor_id_constructors_id_fk" FOREIGN KEY ("constructor_id") REFERENCES "public"."constructors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_participants" ADD CONSTRAINT "session_participants_snapshot_id_raw_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."raw_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_result_state" ADD CONSTRAINT "session_result_state_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_result_state" ADD CONSTRAINT "session_result_state_current_snapshot_id_raw_snapshots_id_fk" FOREIGN KEY ("current_snapshot_id") REFERENCES "public"."raw_snapshots"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "jobs_run_at_pending_idx" ON "jobs" USING btree ("run_at") WHERE "jobs"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "jobs_status_finished_at_idx" ON "jobs" USING btree ("status","finished_at");--> statement-breakpoint
CREATE INDEX "provider_requests_requested_at_idx" ON "provider_requests" USING btree ("requested_at");--> statement-breakpoint
CREATE INDEX "raw_snapshots_params_hash_first_fetched_at_idx" ON "raw_snapshots" USING btree ("params_hash","first_fetched_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "raw_snapshots_session_id_idx" ON "raw_snapshots" USING btree ("session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "result_overrides_session_id_driver_id_active_unique" ON "result_overrides" USING btree ("session_id","driver_id") WHERE "result_overrides"."revoked_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "review_items_dedupe_key_open_unique" ON "review_items" USING btree ("dedupe_key") WHERE "review_items"."status" = 'open';--> statement-breakpoint
CREATE INDEX "review_items_open_queue_idx" ON "review_items" USING btree ("status","severity","created_at") WHERE "review_items"."status" = 'open';--> statement-breakpoint
CREATE INDEX "review_items_open_blocking_session_id_idx" ON "review_items" USING btree ("session_id") WHERE "review_items"."status" = 'open' and "review_items"."severity" = 'blocking';