CREATE TABLE "circuits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"locality" text NOT NULL,
	"country" text NOT NULL,
	"latitude" numeric(9, 6) NOT NULL,
	"longitude" numeric(9, 6) NOT NULL,
	"timezone" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "circuits_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "constructor_seasons" (
	"constructor_id" uuid NOT NULL,
	"season_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"short_name" text NOT NULL,
	"color" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "constructor_seasons_pkey" PRIMARY KEY("constructor_id","season_id"),
	CONSTRAINT "constructor_seasons_color_check" CHECK ("constructor_seasons"."color" ~ '^#[0-9A-Fa-f]{6}$')
);
--> statement-breakpoint
CREATE TABLE "constructors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"nationality" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "constructors_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "driver_availability" (
	"event_id" uuid NOT NULL,
	"driver_id" uuid NOT NULL,
	"status" text DEFAULT 'available' NOT NULL,
	"reason" text,
	"source" text DEFAULT 'default' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "driver_availability_pkey" PRIMARY KEY("event_id","driver_id"),
	CONSTRAINT "driver_availability_status_check" CHECK ("driver_availability"."status" in ('available', 'doubtful', 'unavailable', 'reserve')),
	CONSTRAINT "driver_availability_source_check" CHECK ("driver_availability"."source" in ('default', 'roster_check', 'admin'))
);
--> statement-breakpoint
CREATE TABLE "drivers" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"given_name" text NOT NULL,
	"family_name" text NOT NULL,
	"display_name" text,
	"code" text,
	"permanent_number" integer,
	"nationality" text NOT NULL,
	"date_of_birth" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "drivers_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "event_entries" (
	"event_id" uuid NOT NULL,
	"driver_id" uuid NOT NULL,
	"constructor_id" uuid NOT NULL,
	"car_number" integer NOT NULL,
	"source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "event_entries_pkey" PRIMARY KEY("event_id","driver_id"),
	CONSTRAINT "event_entries_source_check" CHECK ("event_entries"."source" in ('seat', 'admin', 'results'))
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"season_id" uuid NOT NULL,
	"round" integer NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"circuit_id" uuid NOT NULL,
	"format" text NOT NULL,
	"status" text NOT NULL,
	"lock_session_id" uuid,
	"lock_at" timestamp with time zone NOT NULL,
	"lock_at_source" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "events_slug_unique" UNIQUE("slug"),
	CONSTRAINT "events_format_check" CHECK ("events"."format" in ('standard', 'sprint')),
	CONSTRAINT "events_status_check" CHECK ("events"."status" in ('scheduled', 'cancelled', 'completed')),
	CONSTRAINT "events_lock_at_source_check" CHECK ("events"."lock_at_source" in ('default', 'admin'))
);
--> statement-breakpoint
CREATE TABLE "provider_ids" (
	"provider" text NOT NULL,
	"entity_type" text NOT NULL,
	"provider_key" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_ids_provider_entity_type_provider_key_unique" UNIQUE("provider","entity_type","provider_key"),
	CONSTRAINT "provider_ids_provider_entity_type_entity_id_unique" UNIQUE("provider","entity_type","entity_id"),
	CONSTRAINT "provider_ids_entity_type_check" CHECK ("provider_ids"."entity_type" in ('circuit', 'event', 'session', 'driver', 'constructor'))
);
--> statement-breakpoint
CREATE TABLE "seasons" (
	"id" uuid PRIMARY KEY NOT NULL,
	"year" integer NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seasons_year_unique" UNIQUE("year"),
	CONSTRAINT "seasons_status_check" CHECK ("seasons"."status" in ('upcoming', 'active', 'completed'))
);
--> statement-breakpoint
CREATE TABLE "seat_assignments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"season_id" uuid NOT NULL,
	"driver_id" uuid NOT NULL,
	"constructor_id" uuid NOT NULL,
	"car_number" integer NOT NULL,
	"role" text NOT NULL,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "seat_assignments_role_check" CHECK ("seat_assignments"."role" in ('race', 'reserve')),
	CONSTRAINT "seat_assignments_valid_range_check" CHECK ("seat_assignments"."valid_to" is null or "seat_assignments"."valid_to" >= "seat_assignments"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"sequence" smallint DEFAULT 1 NOT NULL,
	"scheduled_start" timestamp with time zone NOT NULL,
	"start_confirmed" boolean NOT NULL,
	"scheduled_end" timestamp with time zone NOT NULL,
	"time_source" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_event_id_kind_sequence_unique" UNIQUE("event_id","kind","sequence"),
	CONSTRAINT "sessions_kind_check" CHECK ("sessions"."kind" in ('fp1', 'fp2', 'fp3', 'sprint_qualifying', 'sprint', 'qualifying', 'race')),
	CONSTRAINT "sessions_time_source_check" CHECK ("sessions"."time_source" in ('provider', 'admin')),
	CONSTRAINT "sessions_status_check" CHECK ("sessions"."status" in ('scheduled', 'live', 'suspended', 'completed', 'abandoned', 'cancelled'))
);
--> statement-breakpoint
ALTER TABLE "constructor_seasons" ADD CONSTRAINT "constructor_seasons_constructor_id_constructors_id_fk" FOREIGN KEY ("constructor_id") REFERENCES "public"."constructors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "constructor_seasons" ADD CONSTRAINT "constructor_seasons_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_availability" ADD CONSTRAINT "driver_availability_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "driver_availability" ADD CONSTRAINT "driver_availability_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_entries" ADD CONSTRAINT "event_entries_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_entries" ADD CONSTRAINT "event_entries_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_entries" ADD CONSTRAINT "event_entries_constructor_id_constructors_id_fk" FOREIGN KEY ("constructor_id") REFERENCES "public"."constructors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_circuit_id_circuits_id_fk" FOREIGN KEY ("circuit_id") REFERENCES "public"."circuits"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_lock_session_id_sessions_id_fk" FOREIGN KEY ("lock_session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seat_assignments" ADD CONSTRAINT "seat_assignments_season_id_seasons_id_fk" FOREIGN KEY ("season_id") REFERENCES "public"."seasons"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seat_assignments" ADD CONSTRAINT "seat_assignments_driver_id_drivers_id_fk" FOREIGN KEY ("driver_id") REFERENCES "public"."drivers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seat_assignments" ADD CONSTRAINT "seat_assignments_constructor_id_constructors_id_fk" FOREIGN KEY ("constructor_id") REFERENCES "public"."constructors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_season_id_lock_at_idx" ON "events" USING btree ("season_id","lock_at");--> statement-breakpoint
CREATE INDEX "seat_assignments_season_id_constructor_id_idx" ON "seat_assignments" USING btree ("season_id","constructor_id");--> statement-breakpoint
CREATE INDEX "sessions_scheduled_start_idx" ON "sessions" USING btree ("scheduled_start");