CREATE TABLE "league_memberships" (
	"id" uuid PRIMARY KEY NOT NULL,
	"league_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"joined_at" timestamp with time zone NOT NULL,
	"left_at" timestamp with time zone,
	"source" text NOT NULL,
	CONSTRAINT "league_memberships_source_check" CHECK ("league_memberships"."source" in ('user', 'auto')),
	CONSTRAINT "league_memberships_left_at_check" CHECK ("league_memberships"."left_at" is null or "league_memberships"."left_at" >= "league_memberships"."joined_at")
);
--> statement-breakpoint
CREATE TABLE "league_standings" (
	"league_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"points" integer NOT NULL,
	"first_reached_sequence" integer NOT NULL,
	"rank" integer NOT NULL,
	"previous_rank" integer,
	"through_event_id" uuid NOT NULL,
	"status" text NOT NULL,
	CONSTRAINT "league_standings_league_id_team_id_pk" PRIMARY KEY("league_id","team_id"),
	CONSTRAINT "league_standings_status_check" CHECK ("league_standings"."status" in ('provisional', 'final')),
	CONSTRAINT "league_standings_rank_check" CHECK ("league_standings"."rank" >= 1),
	CONSTRAINT "league_standings_previous_rank_check" CHECK ("league_standings"."previous_rank" is null or "league_standings"."previous_rank" >= 1),
	CONSTRAINT "league_standings_first_reached_check" CHECK ("league_standings"."first_reached_sequence" >= 1)
);
--> statement-breakpoint
CREATE TABLE "leagues" (
	"id" uuid PRIMARY KEY NOT NULL,
	"game_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"owner_user_id" uuid,
	"join_code" text,
	"constructor_id" uuid,
	"driver_id" uuid,
	"country_code" text,
	"start_sequence" integer DEFAULT 1 NOT NULL,
	"end_sequence" integer,
	"max_members" integer,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "leagues_join_code_unique" UNIQUE("join_code"),
	CONSTRAINT "leagues_game_id_slug_unique" UNIQUE("game_id","slug"),
	CONSTRAINT "leagues_game_id_kind_constructor_id_unique" UNIQUE("game_id","kind","constructor_id"),
	CONSTRAINT "leagues_game_id_kind_driver_id_unique" UNIQUE("game_id","kind","driver_id"),
	CONSTRAINT "leagues_game_id_kind_country_code_unique" UNIQUE("game_id","kind","country_code"),
	CONSTRAINT "leagues_kind_check" CHECK ("leagues"."kind" in ('global', 'public', 'private', 'auto_constructor', 'auto_driver', 'auto_country')),
	CONSTRAINT "leagues_status_check" CHECK ("leagues"."status" in ('active', 'archived')),
	CONSTRAINT "leagues_auto_key_check" CHECK (("leagues"."kind" = 'auto_constructor' and "leagues"."constructor_id" is not null and "leagues"."driver_id" is null and "leagues"."country_code" is null)
        or ("leagues"."kind" = 'auto_driver' and "leagues"."driver_id" is not null and "leagues"."constructor_id" is null and "leagues"."country_code" is null)
        or ("leagues"."kind" = 'auto_country' and "leagues"."country_code" is not null and "leagues"."constructor_id" is null and "leagues"."driver_id" is null)
        or ("leagues"."kind" in ('global', 'public', 'private') and "leagues"."constructor_id" is null and "leagues"."driver_id" is null and "leagues"."country_code" is null)),
	CONSTRAINT "leagues_country_code_check" CHECK ("leagues"."country_code" is null or "leagues"."country_code" ~ '^[A-Z]{2,3}$'),
	CONSTRAINT "leagues_user_only_check" CHECK ("leagues"."kind" in ('public', 'private')
        or ("leagues"."owner_user_id" is null and "leagues"."join_code" is null and "leagues"."max_members" is null
            and "leagues"."start_sequence" = 1 and "leagues"."end_sequence" is null)),
	CONSTRAINT "leagues_name_check" CHECK ("leagues"."kind" not in ('public', 'private')
        or char_length("leagues"."name") between 1 and 40),
	CONSTRAINT "leagues_range_check" CHECK ("leagues"."start_sequence" >= 1 and ("leagues"."end_sequence" is null or "leagues"."end_sequence" >= "leagues"."start_sequence")),
	CONSTRAINT "leagues_max_members_check" CHECK ("leagues"."max_members" is null or "leagues"."max_members" >= 1)
);
--> statement-breakpoint
ALTER TABLE "league_memberships" ADD CONSTRAINT "league_memberships_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_memberships" ADD CONSTRAINT "league_memberships_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_standings" ADD CONSTRAINT "league_standings_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_standings" ADD CONSTRAINT "league_standings_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "league_standings" ADD CONSTRAINT "league_standings_through_event_id_events_id_fk" FOREIGN KEY ("through_event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leagues" ADD CONSTRAINT "leagues_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leagues" ADD CONSTRAINT "leagues_constructor_id_constructors_id_fk" FOREIGN KEY ("constructor_id") REFERENCES "public"."constructors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leagues" ADD CONSTRAINT "leagues_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "league_memberships_league_id_team_id_active_unique" ON "league_memberships" USING btree ("league_id","team_id") WHERE "league_memberships"."left_at" is null;--> statement-breakpoint
CREATE INDEX "league_memberships_team_id_active_idx" ON "league_memberships" USING btree ("team_id") WHERE "league_memberships"."left_at" is null;--> statement-breakpoint
CREATE INDEX "league_standings_league_id_rank_idx" ON "league_standings" USING btree ("league_id","rank");--> statement-breakpoint
CREATE UNIQUE INDEX "leagues_game_id_global_unique" ON "leagues" USING btree ("game_id") WHERE "leagues"."kind" = 'global';