CREATE TABLE "chip_plays" (
	"id" uuid PRIMARY KEY NOT NULL,
	"team_id" uuid NOT NULL,
	"game_id" uuid NOT NULL,
	"chip_code" text NOT NULL,
	"event_id" uuid NOT NULL,
	"target_asset_id" uuid,
	"played_at" timestamp with time zone DEFAULT app_now() NOT NULL,
	"status" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chip_plays_status_check" CHECK ("chip_plays"."status" in ('played', 'refunded'))
);
--> statement-breakpoint
ALTER TABLE "team_event_states" ADD COLUMN "chip_play_id" uuid;--> statement-breakpoint
ALTER TABLE "chip_plays" ADD CONSTRAINT "chip_plays_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chip_plays" ADD CONSTRAINT "chip_plays_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chip_plays" ADD CONSTRAINT "chip_plays_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chip_plays" ADD CONSTRAINT "chip_plays_target_asset_id_pool_assets_id_fk" FOREIGN KEY ("target_asset_id") REFERENCES "public"."pool_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chip_plays_team_id_chip_code_played_unique" ON "chip_plays" USING btree ("team_id","chip_code") WHERE "chip_plays"."status" = 'played';--> statement-breakpoint
CREATE UNIQUE INDEX "chip_plays_team_id_event_id_played_unique" ON "chip_plays" USING btree ("team_id","event_id") WHERE "chip_plays"."status" = 'played';--> statement-breakpoint
CREATE INDEX "chip_plays_event_id_played_idx" ON "chip_plays" USING btree ("event_id") WHERE "chip_plays"."status" = 'played';--> statement-breakpoint
ALTER TABLE "team_event_states" ADD CONSTRAINT "team_event_states_chip_play_id_chip_plays_id_fk" FOREIGN KEY ("chip_play_id") REFERENCES "public"."chip_plays"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lineup_versions_team_id_for_event_id_final_fix_unique" ON "lineup_versions" USING btree ("team_id","for_event_id") WHERE "lineup_versions"."kind" = 'final_fix';