CREATE TABLE "auth_accounts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_rate_limits" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "auth_rate_limits_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"user_id" uuid NOT NULL,
	"impersonated_by" uuid,
	"staff_verified_at" timestamp with time zone,
	CONSTRAINT "auth_sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "auth_two_factors" (
	"id" uuid PRIMARY KEY NOT NULL,
	"secret" text NOT NULL,
	"backup_codes" text NOT NULL,
	"user_id" uuid NOT NULL,
	"verified" boolean DEFAULT true NOT NULL,
	"failed_verification_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "auth_verifications" (
	"id" uuid PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_outbox" (
	"id" uuid PRIMARY KEY NOT NULL,
	"to_email" text,
	"template" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"send_after" timestamp with time zone NOT NULL,
	"provider_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"last_error" text,
	CONSTRAINT "email_outbox_template_check" CHECK ("email_outbox"."template" in ('verify_email', 'magic_link', 'password_reset', 'email_change_notice', 'delete_confirm')),
	CONSTRAINT "email_outbox_status_check" CHECK ("email_outbox"."status" in ('queued', 'sent', 'failed', 'expired')),
	CONSTRAINT "email_outbox_queued_to_email_check" CHECK ("email_outbox"."status" <> 'queued' or "email_outbox"."to_email" is not null)
);
--> statement-breakpoint
CREATE TABLE "filter_rules" (
	"id" uuid PRIMARY KEY NOT NULL,
	"pattern" text NOT NULL,
	"match_type" text NOT NULL,
	"effect" text NOT NULL,
	"scope" text NOT NULL,
	"created_by" uuid NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "filter_rules_match_type_check" CHECK ("filter_rules"."match_type" in ('word', 'regex', 'domain')),
	CONSTRAINT "filter_rules_effect_check" CHECK ("filter_rules"."effect" in ('block', 'hold_for_review', 'flag')),
	CONSTRAINT "filter_rules_scope_check" CHECK ("filter_rules"."scope" in ('all', 'titles', 'chat', 'usernames'))
);
--> statement-breakpoint
CREATE TABLE "legal_acceptances" (
	"user_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"accepted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "legal_acceptances_user_id_document_id_pk" PRIMARY KEY("user_id","document_id")
);
--> statement-breakpoint
CREATE TABLE "legal_documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"version" text NOT NULL,
	"published_at" timestamp with time zone NOT NULL,
	"requires_reacceptance" boolean DEFAULT false NOT NULL,
	"url" text NOT NULL,
	CONSTRAINT "legal_documents_kind_version_unique" UNIQUE("kind","version"),
	CONSTRAINT "legal_documents_kind_check" CHECK ("legal_documents"."kind" in ('terms', 'privacy', 'community_rules'))
);
--> statement-breakpoint
CREATE TABLE "privacy_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"export_object_key" text,
	"export_expires_at" timestamp with time zone,
	"export_url" text,
	"confirm_token_hash" text,
	"confirm_expires_at" timestamp with time zone,
	CONSTRAINT "privacy_requests_kind_check" CHECK ("privacy_requests"."kind" in ('export', 'delete')),
	CONSTRAINT "privacy_requests_status_check" CHECK ("privacy_requests"."status" in ('pending', 'processing', 'completed', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"avatar_seed" text NOT NULL,
	"favorite_constructor_id" uuid,
	"favorite_driver_id" uuid,
	"country_code" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"spoiler_protection" boolean DEFAULT true NOT NULL,
	"age_confirmed_at" timestamp with time zone,
	"trust_level" smallint DEFAULT 0 NOT NULL,
	"trust_level_locked" boolean DEFAULT false NOT NULL,
	"reputation" integer DEFAULT 0 NOT NULL,
	"days_visited" integer DEFAULT 0 NOT NULL,
	"last_seen_at" timestamp with time zone,
	"broadcasts_read_at" timestamp with time zone,
	"username_changed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "profiles_status_check" CHECK ("profiles"."status" in ('active', 'deleted')),
	CONSTRAINT "profiles_trust_level_check" CHECK ("profiles"."trust_level" between 0 and 3)
);
--> statement-breakpoint
CREATE TABLE "trust_level_changes" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"from_level" smallint NOT NULL,
	"to_level" smallint NOT NULL,
	"source" text NOT NULL,
	"changed_by" uuid,
	"reason" text,
	"changed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "trust_level_changes_levels_check" CHECK ("trust_level_changes"."from_level" between 0 and 3 and "trust_level_changes"."to_level" between 0 and 3),
	CONSTRAINT "trust_level_changes_source_check" CHECK ("trust_level_changes"."source" in ('auto', 'moderator'))
);
--> statement-breakpoint
CREATE TABLE "username_history" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"username" text NOT NULL,
	"changed_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"role" text DEFAULT 'user' NOT NULL,
	"banned" boolean DEFAULT false NOT NULL,
	"ban_reason" text,
	"ban_expires" timestamp with time zone,
	"username" text,
	"display_username" text,
	"two_factor_enabled" boolean DEFAULT false NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_username_unique" UNIQUE("username"),
	CONSTRAINT "users_role_check" CHECK ("users"."role" in ('user', 'moderator', 'admin', 'system'))
);
--> statement-breakpoint
ALTER TABLE "auth_accounts" ADD CONSTRAINT "auth_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_impersonated_by_users_id_fk" FOREIGN KEY ("impersonated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_two_factors" ADD CONSTRAINT "auth_two_factors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "filter_rules" ADD CONSTRAINT "filter_rules_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_acceptances" ADD CONSTRAINT "legal_acceptances_document_id_legal_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."legal_documents"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "privacy_requests" ADD CONSTRAINT "privacy_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_favorite_constructor_id_constructors_id_fk" FOREIGN KEY ("favorite_constructor_id") REFERENCES "public"."constructors"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_favorite_driver_id_drivers_id_fk" FOREIGN KEY ("favorite_driver_id") REFERENCES "public"."drivers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_level_changes" ADD CONSTRAINT "trust_level_changes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trust_level_changes" ADD CONSTRAINT "trust_level_changes_changed_by_users_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "username_history" ADD CONSTRAINT "username_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "auth_accounts_user_id_idx" ON "auth_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_user_id_idx" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_expires_at_idx" ON "auth_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "auth_two_factors_secret_idx" ON "auth_two_factors" USING btree ("secret");--> statement-breakpoint
CREATE INDEX "auth_two_factors_user_id_idx" ON "auth_two_factors" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_verifications_identifier_idx" ON "auth_verifications" USING btree ("identifier");--> statement-breakpoint
CREATE UNIQUE INDEX "email_outbox_queued_to_email_template_idx" ON "email_outbox" USING btree (lower("to_email"),"template") WHERE "email_outbox"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "email_outbox_status_send_after_idx" ON "email_outbox" USING btree ("status","send_after");--> statement-breakpoint
CREATE INDEX "filter_rules_scope_active_idx" ON "filter_rules" USING btree ("scope","active");--> statement-breakpoint
CREATE INDEX "privacy_requests_user_id_idx" ON "privacy_requests" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "privacy_requests_open_status_idx" ON "privacy_requests" USING btree ("status") WHERE "privacy_requests"."status" in ('pending', 'processing');--> statement-breakpoint
CREATE INDEX "profiles_favorite_constructor_id_idx" ON "profiles" USING btree ("favorite_constructor_id");--> statement-breakpoint
CREATE INDEX "profiles_favorite_driver_id_idx" ON "profiles" USING btree ("favorite_driver_id");--> statement-breakpoint
CREATE INDEX "profiles_country_code_idx" ON "profiles" USING btree ("country_code");--> statement-breakpoint
CREATE INDEX "profiles_status_last_seen_at_idx" ON "profiles" USING btree ("status","last_seen_at");--> statement-breakpoint
CREATE INDEX "trust_level_changes_user_id_changed_at_idx" ON "trust_level_changes" USING btree ("user_id","changed_at");--> statement-breakpoint
CREATE INDEX "username_history_user_id_idx" ON "username_history" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "username_history_username_lower_changed_at_idx" ON "username_history" USING btree (lower("username"),"changed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_lower_idx" ON "users" USING btree (lower("username"));