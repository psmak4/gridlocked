CREATE TABLE "team_event_states" (
	"team_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"game_id" uuid NOT NULL,
	"base_version_id" uuid,
	"locked_version_id" uuid NOT NULL,
	"final_fix_version_id" uuid,
	"is_first_event" boolean NOT NULL,
	"purchasing_power" integer NOT NULL,
	"spent" integer NOT NULL,
	"bank" integer NOT NULL,
	"transfers_made" integer NOT NULL,
	"free_transfers" integer,
	"carry_over_out" smallint NOT NULL,
	"transfer_penalty" integer NOT NULL,
	"ruleset_version_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "team_event_states_team_id_event_id_pk" PRIMARY KEY("team_id","event_id")
);
--> statement-breakpoint
ALTER TABLE "team_event_states" ADD CONSTRAINT "team_event_states_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_event_states" ADD CONSTRAINT "team_event_states_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_event_states" ADD CONSTRAINT "team_event_states_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_event_states" ADD CONSTRAINT "team_event_states_base_version_id_lineup_versions_id_fk" FOREIGN KEY ("base_version_id") REFERENCES "public"."lineup_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_event_states" ADD CONSTRAINT "team_event_states_locked_version_id_lineup_versions_id_fk" FOREIGN KEY ("locked_version_id") REFERENCES "public"."lineup_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_event_states" ADD CONSTRAINT "team_event_states_final_fix_version_id_lineup_versions_id_fk" FOREIGN KEY ("final_fix_version_id") REFERENCES "public"."lineup_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_event_states" ADD CONSTRAINT "team_event_states_ruleset_version_id_ruleset_versions_id_fk" FOREIGN KEY ("ruleset_version_id") REFERENCES "public"."ruleset_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "team_event_states_event_id_idx" ON "team_event_states" USING btree ("event_id");