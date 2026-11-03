CREATE TABLE "lineup_picks" (
	"lineup_version_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"is_boost" boolean NOT NULL,
	CONSTRAINT "lineup_picks_lineup_version_id_asset_id_pk" PRIMARY KEY("lineup_version_id","asset_id")
);
--> statement-breakpoint
CREATE TABLE "lineup_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"team_id" uuid NOT NULL,
	"for_event_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"effective_from_session_id" uuid,
	"based_on_version_id" uuid,
	"saved_at" timestamp with time zone DEFAULT app_now() NOT NULL,
	CONSTRAINT "lineup_versions_kind_check" CHECK ("lineup_versions"."kind" in ('regular', 'limitless', 'final_fix')),
	CONSTRAINT "lineup_versions_final_fix_session_check" CHECK (("lineup_versions"."kind" = 'final_fix') = ("lineup_versions"."effective_from_session_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "lineup_picks" ADD CONSTRAINT "lineup_picks_lineup_version_id_lineup_versions_id_fk" FOREIGN KEY ("lineup_version_id") REFERENCES "public"."lineup_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lineup_picks" ADD CONSTRAINT "lineup_picks_asset_id_pool_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."pool_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lineup_versions" ADD CONSTRAINT "lineup_versions_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lineup_versions" ADD CONSTRAINT "lineup_versions_for_event_id_events_id_fk" FOREIGN KEY ("for_event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lineup_versions" ADD CONSTRAINT "lineup_versions_effective_from_session_id_sessions_id_fk" FOREIGN KEY ("effective_from_session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lineup_versions" ADD CONSTRAINT "lineup_versions_based_on_version_id_lineup_versions_id_fk" FOREIGN KEY ("based_on_version_id") REFERENCES "public"."lineup_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lineup_picks_asset_id_idx" ON "lineup_picks" USING btree ("asset_id");--> statement-breakpoint
CREATE INDEX "lineup_versions_team_id_for_event_id_saved_at_idx" ON "lineup_versions" USING btree ("team_id","for_event_id","saved_at" DESC NULLS LAST);