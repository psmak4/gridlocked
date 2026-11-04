CREATE TABLE "asset_score_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"game_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"rule_code" text NOT NULL,
	"category" text NOT NULL,
	"subject_driver_id" uuid,
	"points" integer NOT NULL,
	"detail" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scoring_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"game_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"ruleset_version_id" uuid NOT NULL,
	"engine_version" text NOT NULL,
	"input_fingerprint" text NOT NULL,
	"trigger" text NOT NULL,
	"mode" text NOT NULL,
	"status" text NOT NULL,
	"is_current" boolean DEFAULT false NOT NULL,
	"inputs" jsonb,
	"diff_summary" jsonb,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "scoring_runs_trigger_check" CHECK ("scoring_runs"."trigger" in ('results', 'override', 'exception', 'ruleset_correction', 'engine_change', 'admin', 'replay')),
	CONSTRAINT "scoring_runs_mode_check" CHECK ("scoring_runs"."mode" in ('live', 'dry_run')),
	CONSTRAINT "scoring_runs_status_check" CHECK ("scoring_runs"."status" in ('running', 'succeeded', 'failed', 'superseded')),
	CONSTRAINT "scoring_runs_current_live_check" CHECK (not "scoring_runs"."is_current" or "scoring_runs"."mode" = 'live')
);
--> statement-breakpoint
CREATE TABLE "team_adjustment_lines" (
	"id" uuid PRIMARY KEY NOT NULL,
	"game_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"session_id" uuid,
	"asset_id" uuid,
	"line_type" text NOT NULL,
	"category" text,
	"points" integer NOT NULL,
	"run_id" uuid NOT NULL,
	CONSTRAINT "team_adjustment_lines_line_type_check" CHECK ("team_adjustment_lines"."line_type" in ('boost', 'triple_boost', 'autopilot_remove', 'autopilot_add', 'no_negative', 'transfer_penalty'))
);
--> statement-breakpoint
ALTER TABLE "asset_score_lines" ADD CONSTRAINT "asset_score_lines_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_score_lines" ADD CONSTRAINT "asset_score_lines_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_score_lines" ADD CONSTRAINT "asset_score_lines_run_id_scoring_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."scoring_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_score_lines" ADD CONSTRAINT "asset_score_lines_asset_id_pool_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."pool_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_score_lines" ADD CONSTRAINT "asset_score_lines_subject_driver_id_drivers_id_fk" FOREIGN KEY ("subject_driver_id") REFERENCES "public"."drivers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoring_runs" ADD CONSTRAINT "scoring_runs_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoring_runs" ADD CONSTRAINT "scoring_runs_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoring_runs" ADD CONSTRAINT "scoring_runs_ruleset_version_id_ruleset_versions_id_fk" FOREIGN KEY ("ruleset_version_id") REFERENCES "public"."ruleset_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_adjustment_lines" ADD CONSTRAINT "team_adjustment_lines_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_adjustment_lines" ADD CONSTRAINT "team_adjustment_lines_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_adjustment_lines" ADD CONSTRAINT "team_adjustment_lines_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_adjustment_lines" ADD CONSTRAINT "team_adjustment_lines_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_adjustment_lines" ADD CONSTRAINT "team_adjustment_lines_asset_id_pool_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."pool_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_adjustment_lines" ADD CONSTRAINT "team_adjustment_lines_run_id_scoring_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."scoring_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "asset_score_lines_line_unique" ON "asset_score_lines" USING btree ("game_id","session_id","asset_id","rule_code",coalesce("subject_driver_id", '00000000-0000-0000-0000-000000000000'::uuid));--> statement-breakpoint
CREATE UNIQUE INDEX "scoring_runs_game_id_session_id_current_unique" ON "scoring_runs" USING btree ("game_id","session_id") WHERE "scoring_runs"."is_current";--> statement-breakpoint
CREATE INDEX "team_adjustment_lines_game_id_event_id_idx" ON "team_adjustment_lines" USING btree ("game_id","event_id");--> statement-breakpoint
CREATE INDEX "team_adjustment_lines_team_id_event_id_idx" ON "team_adjustment_lines" USING btree ("team_id","event_id");