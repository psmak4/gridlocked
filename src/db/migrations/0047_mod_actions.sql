CREATE TABLE "mod_actions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"moderator_user_id" uuid,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"target_user_id" uuid,
	"reason" text NOT NULL,
	"until" timestamp with time zone,
	"queue_item_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mod_actions_action_check" CHECK ("mod_actions"."action" in ('remove', 'restore', 'lock', 'unlock', 'pin', 'unpin', 'move', 'retitle', 'warn', 'mute', 'unmute', 'chat_ban', 'ban', 'unban', 'set_trust_level')),
	CONSTRAINT "mod_actions_target_type_check" CHECK ("mod_actions"."target_type" in ('post', 'thread', 'chat_message', 'user', 'team_name', 'league_name')),
	CONSTRAINT "mod_actions_reason_check" CHECK (length(btrim("mod_actions"."reason")) > 0)
);
--> statement-breakpoint
ALTER TABLE "mod_actions" ADD CONSTRAINT "mod_actions_moderator_user_id_users_id_fk" FOREIGN KEY ("moderator_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mod_actions" ADD CONSTRAINT "mod_actions_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mod_actions" ADD CONSTRAINT "mod_actions_queue_item_id_mod_queue_items_id_fk" FOREIGN KEY ("queue_item_id") REFERENCES "public"."mod_queue_items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mod_actions_target_user_idx" ON "mod_actions" USING btree ("target_user_id","created_at");--> statement-breakpoint
CREATE INDEX "mod_actions_target_idx" ON "mod_actions" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "mod_actions_moderator_idx" ON "mod_actions" USING btree ("moderator_user_id");