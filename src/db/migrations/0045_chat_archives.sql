CREATE TABLE "chat_archives" (
	"thread_id" uuid PRIMARY KEY NOT NULL,
	"object_key" text NOT NULL,
	"message_count" integer NOT NULL,
	"first_message_at" timestamp with time zone,
	"last_message_at" timestamp with time zone,
	"bytes" integer NOT NULL,
	"archived_at" timestamp with time zone NOT NULL,
	CONSTRAINT "chat_archives_count_check" CHECK ("chat_archives"."message_count" >= 0),
	CONSTRAINT "chat_archives_bytes_check" CHECK ("chat_archives"."bytes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "chat_archives" ADD CONSTRAINT "chat_archives_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE restrict ON UPDATE no action;