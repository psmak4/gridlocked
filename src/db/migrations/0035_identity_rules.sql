-- The rules and rows Drizzle cannot express for identity (DM Part 6).

-- The reserved system user (DM 6.1): the author of results posts and auto
-- threads, and the actor on rows made by staff tooling. It has the all-zero id
-- that the first staff rows already hold, so a later foreign key finds it.
-- It has no auth_accounts rows and can never sign in.
INSERT INTO "users" ("id", "name", "email", "email_verified", "role")
VALUES ('00000000-0000-0000-0000-000000000000', 'system', 'system@gridlocked.invalid', true, 'system');
--> statement-breakpoint
INSERT INTO "profiles" ("user_id", "status", "avatar_seed")
VALUES ('00000000-0000-0000-0000-000000000000', 'active', 'system');
--> statement-breakpoint

-- No sign-in method for a system user, whoever asks: the application also
-- never offers one, but this is what makes "can never sign in" true.
CREATE FUNCTION "auth_accounts_no_system_user"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "users" u WHERE u."id" = NEW."user_id" AND u."role" = 'system') THEN
    RAISE EXCEPTION 'auth account: a system user has no sign-in methods'
      USING ERRCODE = 'restrict_violation',
            DETAIL = format('user %s has role system', NEW."user_id");
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "auth_accounts_no_system_user"
BEFORE INSERT ON "auth_accounts"
FOR EACH ROW EXECUTE FUNCTION "auth_accounts_no_system_user"();
--> statement-breakpoint

-- Reserved usernames (DM 6.3), as filter rules of scope `usernames` made by the
-- system user. Words match the whole name. Regex patterns are written in
-- lowercase and matched with the `i` flag: `f1` and `fia` as separate words
-- within a name (so F1_Official is blocked and mf1 is not), `official`,
-- `formula1` and `formula_1` anywhere. Team and driver names come with the
-- reference data later.
INSERT INTO "filter_rules" ("id", "pattern", "match_type", "effect", "scope", "created_by") VALUES
  (gen_random_uuid(), 'admin', 'word', 'block', 'usernames', '00000000-0000-0000-0000-000000000000'),
  (gen_random_uuid(), 'moderator', 'word', 'block', 'usernames', '00000000-0000-0000-0000-000000000000'),
  (gen_random_uuid(), 'gridlocked', 'word', 'block', 'usernames', '00000000-0000-0000-0000-000000000000'),
  (gen_random_uuid(), 'system', 'word', 'block', 'usernames', '00000000-0000-0000-0000-000000000000'),
  (gen_random_uuid(), 'support', 'word', 'block', 'usernames', '00000000-0000-0000-0000-000000000000'),
  (gen_random_uuid(), '(^|[^a-z0-9])f1($|[^a-z0-9])', 'regex', 'block', 'usernames', '00000000-0000-0000-0000-000000000000'),
  (gen_random_uuid(), 'formula1', 'regex', 'block', 'usernames', '00000000-0000-0000-0000-000000000000'),
  (gen_random_uuid(), 'formula_1', 'regex', 'block', 'usernames', '00000000-0000-0000-0000-000000000000'),
  (gen_random_uuid(), '(^|[^a-z0-9])fia($|[^a-z0-9])', 'regex', 'block', 'usernames', '00000000-0000-0000-0000-000000000000'),
  (gen_random_uuid(), 'official', 'regex', 'block', 'usernames', '00000000-0000-0000-0000-000000000000');
