CREATE TABLE "team_event_totals" (
	"game_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"event_sequence" integer NOT NULL,
	"points" integer NOT NULL,
	"points_by_session" jsonb NOT NULL,
	"cumulative_points" integer NOT NULL,
	"first_reached_sequence" integer NOT NULL,
	"global_rank" integer NOT NULL,
	"status" text NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "team_event_totals_team_id_event_id_pk" PRIMARY KEY("team_id","event_id"),
	CONSTRAINT "team_event_totals_status_check" CHECK ("team_event_totals"."status" in ('provisional', 'final')),
	CONSTRAINT "team_event_totals_first_reached_check" CHECK ("team_event_totals"."first_reached_sequence" between 1 and "team_event_totals"."event_sequence"),
	CONSTRAINT "team_event_totals_global_rank_check" CHECK ("team_event_totals"."global_rank" >= 1)
);
--> statement-breakpoint
ALTER TABLE "team_event_totals" ADD CONSTRAINT "team_event_totals_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_event_totals" ADD CONSTRAINT "team_event_totals_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_event_totals" ADD CONSTRAINT "team_event_totals_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "team_event_totals_game_id_event_id_global_rank_idx" ON "team_event_totals" USING btree ("game_id","event_id","global_rank");--> statement-breakpoint
CREATE INDEX "team_event_totals_team_id_event_sequence_idx" ON "team_event_totals" USING btree ("team_id","event_sequence");