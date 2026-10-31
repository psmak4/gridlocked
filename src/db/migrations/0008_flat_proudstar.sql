CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY NOT NULL,
	"actor_user_id" uuid,
	"actor_kind" text NOT NULL,
	"actor_label" text,
	"impersonating_user_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"request_id" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "audit_log_actor_kind_check" CHECK ("audit_log"."actor_kind" in ('admin', 'moderator', 'user', 'system', 'job'))
);
--> statement-breakpoint
CREATE INDEX "audit_log_entity_type_entity_id_created_at_idx" ON "audit_log" USING btree ("entity_type","entity_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_log_actor_user_id_created_at_idx" ON "audit_log" USING btree ("actor_user_id","created_at");