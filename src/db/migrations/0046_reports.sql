CREATE TABLE "mod_queue_items" (
	"id" uuid PRIMARY KEY NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"target_user_id" uuid,
	"source" text NOT NULL,
	"report_count" integer DEFAULT 0 NOT NULL,
	"weight_sum" real DEFAULT 0 NOT NULL,
	"content_snapshot" jsonb NOT NULL,
	"filter_hits" jsonb,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	"version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mod_queue_items_target_type_check" CHECK ("mod_queue_items"."target_type" in ('post', 'thread', 'chat_message', 'user', 'team_name', 'league_name')),
	CONSTRAINT "mod_queue_items_source_check" CHECK ("mod_queue_items"."source" in ('reports', 'filter', 'auto_hide')),
	CONSTRAINT "mod_queue_items_status_check" CHECK ("mod_queue_items"."status" in ('open', 'actioned', 'dismissed')),
	CONSTRAINT "mod_queue_items_counts_check" CHECK ("mod_queue_items"."report_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY NOT NULL,
	"queue_item_id" uuid NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"reporter_user_id" uuid,
	"reporter_contact" text,
	"reason" text NOT NULL,
	"note" text,
	"weight" real NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reports_target_type_check" CHECK ("reports"."target_type" in ('post', 'thread', 'chat_message', 'user', 'team_name', 'league_name')),
	CONSTRAINT "reports_reason_check" CHECK ("reports"."reason" in ('spam', 'abuse', 'spoiler', 'off_topic', 'illegal', 'copyright', 'other')),
	CONSTRAINT "reports_weight_check" CHECK ("reports"."weight" >= 0),
	CONSTRAINT "reports_note_length_check" CHECK ("reports"."note" is null or char_length("reports"."note") <= 1000)
);
--> statement-breakpoint
ALTER TABLE "mod_queue_items" ADD CONSTRAINT "mod_queue_items_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mod_queue_items" ADD CONSTRAINT "mod_queue_items_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_queue_item_id_mod_queue_items_id_fk" FOREIGN KEY ("queue_item_id") REFERENCES "public"."mod_queue_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_reporter_user_id_users_id_fk" FOREIGN KEY ("reporter_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mod_queue_items_open_target_unique" ON "mod_queue_items" USING btree ("target_type","target_id") WHERE "mod_queue_items"."status" = 'open';--> statement-breakpoint
CREATE INDEX "mod_queue_items_open_idx" ON "mod_queue_items" USING btree ("status","created_at") WHERE "mod_queue_items"."status" = 'open';--> statement-breakpoint
CREATE INDEX "mod_queue_items_target_user_idx" ON "mod_queue_items" USING btree ("target_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_reporter_target_unique" ON "reports" USING btree ("target_type","target_id","reporter_user_id") WHERE "reports"."reporter_user_id" is not null;--> statement-breakpoint
CREATE INDEX "reports_queue_item_idx" ON "reports" USING btree ("queue_item_id");--> statement-breakpoint
CREATE INDEX "reports_reporter_idx" ON "reports" USING btree ("reporter_user_id");