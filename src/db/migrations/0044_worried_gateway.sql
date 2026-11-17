CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"thread_id" uuid NOT NULL,
	"session_id" uuid,
	"author_user_id" uuid NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'visible' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_messages_status_check" CHECK ("chat_messages"."status" in ('visible', 'removed')),
	CONSTRAINT "chat_messages_body_length_check" CHECK (char_length("chat_messages"."body") between 1 and 500)
);
--> statement-breakpoint
CREATE TABLE "user_restrictions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"until" timestamp with time zone,
	"reason" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lifted_at" timestamp with time zone,
	CONSTRAINT "user_restrictions_kind_check" CHECK ("user_restrictions"."kind" in ('mute', 'chat_ban', 'thread_ban')),
	CONSTRAINT "user_restrictions_reason_check" CHECK (length(btrim("user_restrictions"."reason")) > 0)
);
--> statement-breakpoint
ALTER TABLE "threads" ADD COLUMN "slow_mode_seconds" smallint;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_restrictions" ADD CONSTRAINT "user_restrictions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_restrictions" ADD CONSTRAINT "user_restrictions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_messages_thread_id_idx" ON "chat_messages" USING btree ("thread_id","id");--> statement-breakpoint
CREATE INDEX "chat_messages_author_created_idx" ON "chat_messages" USING btree ("author_user_id","created_at");--> statement-breakpoint
CREATE INDEX "user_restrictions_active_idx" ON "user_restrictions" USING btree ("user_id") WHERE "user_restrictions"."lifted_at" is null;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_slow_mode_check" CHECK ("threads"."slow_mode_seconds" is null or "threads"."slow_mode_seconds" between 0 and 3600);