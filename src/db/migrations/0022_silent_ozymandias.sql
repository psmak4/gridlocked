CREATE TABLE "game_session_exceptions" (
	"game_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"policy" text NOT NULL,
	"reason" text NOT NULL,
	"decided_by" uuid NOT NULL,
	"decided_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "game_session_exceptions_game_id_session_id_pk" PRIMARY KEY("game_id","session_id"),
	CONSTRAINT "game_session_exceptions_policy_check" CHECK ("game_session_exceptions"."policy" in ('skip'))
);
--> statement-breakpoint
ALTER TABLE "game_session_exceptions" ADD CONSTRAINT "game_session_exceptions_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "game_session_exceptions" ADD CONSTRAINT "game_session_exceptions_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;