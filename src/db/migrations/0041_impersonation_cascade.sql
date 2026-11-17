ALTER TABLE "auth_sessions" DROP CONSTRAINT "auth_sessions_impersonated_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_impersonated_by_users_id_fk" FOREIGN KEY ("impersonated_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;