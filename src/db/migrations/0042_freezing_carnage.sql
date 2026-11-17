-- posts.path is an ltree (DM 5.4). Neon and PGlite both ship the extension.
CREATE EXTENSION IF NOT EXISTS ltree;
--> statement-breakpoint
CREATE TABLE "categories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"position" integer NOT NULL,
	"kind" text NOT NULL,
	"min_trust_to_start_thread" smallint DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	CONSTRAINT "categories_slug_unique" UNIQUE("slug"),
	CONSTRAINT "categories_kind_check" CHECK ("categories"."kind" in ('general', 'race_weekend', 'fantasy', 'news')),
	CONSTRAINT "categories_status_check" CHECK ("categories"."status" in ('active', 'archived')),
	CONSTRAINT "categories_min_trust_check" CHECK ("categories"."min_trust_to_start_thread" between 0 and 3)
);
--> statement-breakpoint
CREATE TABLE "post_mentions" (
	"post_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "post_mentions_post_id_user_id_pk" PRIMARY KEY("post_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "post_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"post_id" uuid NOT NULL,
	"body" text NOT NULL,
	"edited_at" timestamp with time zone NOT NULL,
	"edited_by" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "post_votes" (
	"post_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"value" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "post_votes_post_id_user_id_pk" PRIMARY KEY("post_id","user_id"),
	CONSTRAINT "post_votes_value_check" CHECK ("post_votes"."value" in (1, -1))
);
--> statement-breakpoint
CREATE TABLE "posts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"thread_id" uuid NOT NULL,
	"parent_post_id" uuid,
	"path" "ltree" NOT NULL,
	"depth" smallint DEFAULT 0 NOT NULL,
	"is_opening" boolean DEFAULT false NOT NULL,
	"author_user_id" uuid NOT NULL,
	"body" text NOT NULL,
	"session_id" uuid,
	"contains_spoilers" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'visible' NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"upvotes" integer DEFAULT 0 NOT NULL,
	"downvotes" integer DEFAULT 0 NOT NULL,
	"edit_count" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"edited_at" timestamp with time zone,
	CONSTRAINT "posts_status_check" CHECK ("posts"."status" in ('visible', 'pending_review', 'hidden_by_flags', 'removed', 'deleted_by_author')),
	CONSTRAINT "posts_body_length_check" CHECK (char_length("posts"."body") <= 10000),
	CONSTRAINT "posts_depth_check" CHECK ("posts"."depth" >= 0)
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"category_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"spoiler_safe_title" text,
	"contains_spoilers" boolean DEFAULT false NOT NULL,
	"author_user_id" uuid,
	"session_id" uuid,
	"event_id" uuid,
	"league_id" uuid,
	"chat_opens_at" timestamp with time zone,
	"chat_closes_at" timestamp with time zone,
	"status" text DEFAULT 'open' NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"reply_count" integer DEFAULT 0 NOT NULL,
	"score" integer DEFAULT 0 NOT NULL,
	"hot_rank" real DEFAULT 0 NOT NULL,
	"last_activity_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "threads_kind_check" CHECK ("threads"."kind" in ('user', 'session', 'results', 'league', 'rumor')),
	CONSTRAINT "threads_status_check" CHECK ("threads"."status" in ('open', 'locked', 'removed', 'archived')),
	CONSTRAINT "threads_chat_window_check" CHECK (("threads"."chat_opens_at" is null) = ("threads"."chat_closes_at" is null) and ("threads"."chat_opens_at" is null or "threads"."chat_opens_at" < "threads"."chat_closes_at"))
);
--> statement-breakpoint
ALTER TABLE "post_mentions" ADD CONSTRAINT "post_mentions_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_mentions" ADD CONSTRAINT "post_mentions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_revisions" ADD CONSTRAINT "post_revisions_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_revisions" ADD CONSTRAINT "post_revisions_edited_by_users_id_fk" FOREIGN KEY ("edited_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_votes" ADD CONSTRAINT "post_votes_post_id_posts_id_fk" FOREIGN KEY ("post_id") REFERENCES "public"."posts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "post_votes" ADD CONSTRAINT "post_votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_thread_id_threads_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."threads"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_parent_post_id_posts_id_fk" FOREIGN KEY ("parent_post_id") REFERENCES "public"."posts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "posts" ADD CONSTRAINT "posts_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_league_id_leagues_id_fk" FOREIGN KEY ("league_id") REFERENCES "public"."leagues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "post_revisions_post_idx" ON "post_revisions" USING btree ("post_id","edited_at");--> statement-breakpoint
CREATE INDEX "post_votes_user_idx" ON "post_votes" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "posts_thread_path_idx" ON "posts" USING btree ("thread_id","path");--> statement-breakpoint
CREATE INDEX "posts_author_created_idx" ON "posts" USING btree ("author_user_id","created_at");--> statement-breakpoint
CREATE INDEX "threads_category_activity_idx" ON "threads" USING btree ("category_id","last_activity_at" DESC NULLS LAST) WHERE "threads"."status" in ('open', 'locked');--> statement-breakpoint
CREATE INDEX "threads_category_hot_idx" ON "threads" USING btree ("category_id","hot_rank" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "threads_session_idx" ON "threads" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "threads_event_idx" ON "threads" USING btree ("event_id");