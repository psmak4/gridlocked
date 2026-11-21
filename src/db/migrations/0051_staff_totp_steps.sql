CREATE TABLE "staff_totp_steps" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"last_step" bigint NOT NULL
);
--> statement-breakpoint
ALTER TABLE "staff_totp_steps" ADD CONSTRAINT "staff_totp_steps_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;