-- Rules Drizzle cannot express for leagues (DM 4.5 to 4.7). The tables,
-- CHECKs and indexes are in the generated migration before this one. The
-- 50-league cap has its own SQLSTATE, so the game layer maps it to an error
-- code:
--   GL008 league_cap  the team is in the most `user` leagues allowed

-- What the database checks on a membership (DM 4.6), when a row is inserted or
-- its team or league changes:
--   the team belongs to the league's game;
--   the league has rows at all (the global league doesn't: every active team
--   is in it by definition), and the source matches its kind: `user` for a
--   public or private league, `auto` for an auto league;
--   the cap (GL008): a team has at most 50 current `user` memberships, this
--   one counted. Joins for one team take turns, so two at once can't both
--   take the 50th place.
CREATE FUNCTION "league_memberships_check"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  league_game uuid;
  league_kind text;
  team_game uuid;
  held integer;
BEGIN
  SELECT l."game_id", l."kind" INTO league_game, league_kind
  FROM "leagues" l WHERE l."id" = NEW."league_id";
  SELECT t."game_id" INTO team_game FROM "teams" t WHERE t."id" = NEW."team_id";
  IF team_game IS DISTINCT FROM league_game THEN
    RAISE EXCEPTION 'league: the team is not in the league''s game'
      USING ERRCODE = 'check_violation',
            DETAIL = format('team %s is not in game %s', NEW."team_id", league_game);
  END IF;
  IF league_kind = 'global' THEN
    RAISE EXCEPTION 'league: the global league has no memberships'
      USING ERRCODE = 'check_violation',
            DETAIL = format('league %s is the global league', NEW."league_id");
  END IF;
  IF (NEW."source" = 'user') <> (league_kind IN ('public', 'private')) THEN
    RAISE EXCEPTION 'league: a % membership does not fit a % league', NEW."source", league_kind
      USING ERRCODE = 'check_violation',
            DETAIL = format('league %s', NEW."league_id");
  END IF;

  IF NEW."source" = 'user' AND NEW."left_at" IS NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('league_cap:' || NEW."team_id", 0));
    SELECT count(*) INTO held
    FROM "league_memberships" m
    WHERE m."team_id" = NEW."team_id" AND m."source" = 'user'
      AND m."left_at" IS NULL AND m."id" <> NEW."id";
    IF held >= 50 THEN
      RAISE EXCEPTION 'league: cap reached'
        USING ERRCODE = 'GL008',
              DETAIL = format('team %s is in %s leagues', NEW."team_id", held);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "league_memberships_check"
  BEFORE INSERT OR UPDATE OF "league_id", "team_id", "source", "left_at"
  ON "league_memberships"
  FOR EACH ROW EXECUTE FUNCTION "league_memberships_check"();
