-- More rules Drizzle cannot express for the fantasy core (DM Part 3). The
-- teams table is in the generated migration before this one.

-- The slot limit (DM 3.6): a team's slot runs from 1 to `teamsPerUser` in the
-- game's latest ruleset version. The unique key on (game_id, user_id, slot)
-- makes two simultaneous creates for one slot fight over the key, so only one
-- commits. The trigger runs when a team is added and when its slot or game
-- changes, so an update can't move a team out of range either.
CREATE FUNCTION "teams_slot_limit"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  per_user integer;
BEGIN
  SELECT ("params" ->> 'teamsPerUser')::integer INTO per_user
  FROM "ruleset_versions"
  WHERE "game_id" = NEW."game_id"
  ORDER BY "version" DESC
  LIMIT 1;
  IF per_user IS NULL THEN
    RAISE EXCEPTION 'teams: game % has no teamsPerUser', NEW."game_id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."slot" < 1 OR NEW."slot" > per_user THEN
    RAISE EXCEPTION 'teams: slot % is outside 1 to %', NEW."slot", per_user
      USING ERRCODE = 'check_violation',
            DETAIL = format('game %s allows %s teams per user', NEW."game_id", per_user);
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "teams_slot_limit"
  BEFORE INSERT OR UPDATE OF "game_id", "slot" ON "teams"
  FOR EACH ROW EXECUTE FUNCTION "teams_slot_limit"();
