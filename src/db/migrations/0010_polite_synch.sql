CREATE TABLE "game_events" (
	"game_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"sequence" integer,
	"status" text NOT NULL,
	"ruleset_version_id" uuid NOT NULL,
	"prices_ready_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "game_events_game_id_event_id_pk" PRIMARY KEY("game_id","event_id"),
	CONSTRAINT "game_events_status_check" CHECK ("game_events"."status" in ('upcoming', 'open', 'locked', 'scored', 'final', 'cancelled'))
);
--> statement-breakpoint
CREATE TABLE "games" (
	"id" uuid PRIMARY KEY NOT NULL,
	"season_id" uuid NOT NULL,
	"game_type" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "games_slug_unique" UNIQUE("slug"),
	CONSTRAINT "games_season_id_game_type_unique" UNIQUE("season_id","game_type"),
	CONSTRAINT "games_game_type_check" CHECK ("games"."game_type" in ('season_fantasy')),
	CONSTRAINT "games_status_check" CHECK ("games"."status" in ('setup', 'open', 'running', 'completed'))
);
--> statement-breakpoint
CREATE TABLE "ruleset_versions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"game_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"effective_from_event_id" uuid NOT NULL,
	"params" jsonb NOT NULL,
	"notes" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ruleset_versions_game_id_version_unique" UNIQUE("game_id","version")
);
--> statement-breakpoint
CREATE TABLE "scoring_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"ruleset_version_id" uuid NOT NULL,
	"code" text NOT NULL,
	"session_kind" text NOT NULL,
	"target" text NOT NULL,
	"kind" text NOT NULL,
	"category" text NOT NULL,
	"params" jsonb NOT NULL,
	"sort_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scoring_rules_ruleset_version_id_code_unique" UNIQUE("ruleset_version_id","code"),
	CONSTRAINT "scoring_rules_session_kind_check" CHECK ("scoring_rules"."session_kind" in ('fp1', 'fp2', 'fp3', 'sprint_qualifying', 'sprint', 'qualifying', 'race')),
	CONSTRAINT "scoring_rules_target_check" CHECK ("scoring_rules"."target" in ('driver', 'constructor')),
	CONSTRAINT "scoring_rules_kind_check" CHECK ("scoring_rules"."kind" in ('position_table', 'positions_delta', 'classification_penalty', 'flag_bonus', 'knockout_stage', 'per_driver_penalty', 'aggregate_drivers'))
);
--> statement-breakpoint
ALTER TABLE "game_events" ADD CONSTRAINT "game_events_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_events" ADD CONSTRAINT "game_events_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_events" ADD CONSTRAINT "game_events_ruleset_version_id_ruleset_versions_id_fk" FOREIGN KEY ("ruleset_version_id") REFERENCES "public"."ruleset_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "games" ADD CONSTRAINT "games_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ruleset_versions" ADD CONSTRAINT "ruleset_versions_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ruleset_versions" ADD CONSTRAINT "ruleset_versions_effective_from_event_id_events_id_fk" FOREIGN KEY ("effective_from_event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scoring_rules" ADD CONSTRAINT "scoring_rules_ruleset_version_id_ruleset_versions_id_fk" FOREIGN KEY ("ruleset_version_id") REFERENCES "public"."ruleset_versions"("id") ON DELETE cascade ON UPDATE no action;