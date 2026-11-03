CREATE TABLE "teams" (
	"id" uuid PRIMARY KEY NOT NULL,
	"game_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"slot" smallint NOT NULL,
	"name" text NOT NULL,
	"first_event_id" uuid,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "teams_game_id_user_id_slot_unique" UNIQUE("game_id","user_id","slot"),
	CONSTRAINT "teams_status_check" CHECK ("teams"."status" in ('active', 'retired')),
	CONSTRAINT "teams_name_check" CHECK (char_length("teams"."name") between 1 and 30)
);
--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teams" ADD CONSTRAINT "teams_first_event_id_events_id_fk" FOREIGN KEY ("first_event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "teams_user_id_idx" ON "teams" USING btree ("user_id");