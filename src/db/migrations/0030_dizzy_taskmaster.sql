CREATE TABLE "price_update_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"game_id" uuid NOT NULL,
	"after_event_id" uuid NOT NULL,
	"ruleset_version_id" uuid NOT NULL,
	"inputs" jsonb NOT NULL,
	"ran_at" timestamp with time zone NOT NULL,
	"ran_by" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "asset_prices" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "price_update_runs" ADD CONSTRAINT "price_update_runs_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_update_runs" ADD CONSTRAINT "price_update_runs_after_event_id_events_id_fk" FOREIGN KEY ("after_event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_update_runs" ADD CONSTRAINT "price_update_runs_ruleset_version_id_ruleset_versions_id_fk" FOREIGN KEY ("ruleset_version_id") REFERENCES "public"."ruleset_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_prices" ADD CONSTRAINT "asset_prices_run_id_price_update_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."price_update_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_prices" ADD CONSTRAINT "asset_prices_run_id_check" CHECK (("asset_prices"."source" = 'formula') = ("asset_prices"."run_id" is not null));