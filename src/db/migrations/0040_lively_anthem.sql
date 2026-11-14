CREATE TABLE "session_watch_marks" (
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"marked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "session_watch_marks_user_id_session_id_pk" PRIMARY KEY("user_id","session_id")
);
--> statement-breakpoint
ALTER TABLE "session_watch_marks" ADD CONSTRAINT "session_watch_marks_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_watch_marks" ADD CONSTRAINT "session_watch_marks_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;