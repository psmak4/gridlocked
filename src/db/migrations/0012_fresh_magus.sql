CREATE TABLE "asset_prices" (
	"asset_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"price" integer NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "asset_prices_asset_id_event_id_pk" PRIMARY KEY("asset_id","event_id"),
	CONSTRAINT "asset_prices_price_check" CHECK ("asset_prices"."price" between 30 and 340),
	CONSTRAINT "asset_prices_source_check" CHECK ("asset_prices"."source" in ('initial', 'formula', 'admin', 'carried'))
);
--> statement-breakpoint
CREATE TABLE "pool_assets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"game_id" uuid NOT NULL,
	"asset_type" text NOT NULL,
	"driver_id" uuid,
	"constructor_id" uuid,
	"status" text NOT NULL,
	"added_from_event_id" uuid NOT NULL,
	"withdrawn_from_event_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pool_assets_game_id_driver_id_unique" UNIQUE("game_id","driver_id"),
	CONSTRAINT "pool_assets_game_id_constructor_id_unique" UNIQUE("game_id","constructor_id"),
	CONSTRAINT "pool_assets_asset_type_check" CHECK ("pool_assets"."asset_type" in ('driver', 'constructor')),
	CONSTRAINT "pool_assets_status_check" CHECK ("pool_assets"."status" in ('active', 'withdrawn')),
	CONSTRAINT "pool_assets_one_subject_check" CHECK (("pool_assets"."asset_type" = 'driver' and "pool_assets"."driver_id" is not null and "pool_assets"."constructor_id" is null)
        or ("pool_assets"."asset_type" = 'constructor' and "pool_assets"."constructor_id" is not null and "pool_assets"."driver_id" is null))
);
--> statement-breakpoint
ALTER TABLE "asset_prices" ADD CONSTRAINT "asset_prices_asset_id_pool_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."pool_assets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "asset_prices" ADD CONSTRAINT "asset_prices_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pool_assets" ADD CONSTRAINT "pool_assets_game_id_games_id_fk" FOREIGN KEY ("game_id") REFERENCES "public"."games"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pool_assets" ADD CONSTRAINT "pool_assets_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pool_assets" ADD CONSTRAINT "pool_assets_constructor_id_constructors_id_fk" FOREIGN KEY ("constructor_id") REFERENCES "public"."constructors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pool_assets" ADD CONSTRAINT "pool_assets_added_from_event_id_events_id_fk" FOREIGN KEY ("added_from_event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pool_assets" ADD CONSTRAINT "pool_assets_withdrawn_from_event_id_events_id_fk" FOREIGN KEY ("withdrawn_from_event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "asset_prices_event_id_idx" ON "asset_prices" USING btree ("event_id");