-- The rest of the ruleset freeze (DM 3.2, 4.9). ruleset_versions_freeze and
-- scoring_rules_freeze of game_rules guard a version's contents, but nothing
-- guarded which version a locked event uses. Past scores are reproducible only
-- if that holds too, so game_events.ruleset_version_id is frozen once the event
-- is locked, scored or final.
--
-- The one exception is the audited correction (publishCorrectionVersion), which
-- sets gridlocked.ruleset_correction to 'on' for the update, with
-- set_config(..., true) so it can't outlive the transaction. current_setting
-- with missing_ok is null when the setting was never set, and '' in a session
-- where a transaction-local value has come and gone.
CREATE FUNCTION "game_events_version_freeze"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" IN ('locked', 'scored', 'final')
     AND NEW."ruleset_version_id" IS DISTINCT FROM OLD."ruleset_version_id"
     AND current_setting('gridlocked.ruleset_correction', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION 'game event is %: its ruleset version moves only by a correction', OLD."status"
      USING ERRCODE = 'restrict_violation',
            DETAIL = format('game %s, event %s', OLD."game_id", OLD."event_id");
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "game_events_version_freeze"
  BEFORE UPDATE OF "ruleset_version_id" ON "game_events"
  FOR EACH ROW EXECUTE FUNCTION "game_events_version_freeze"();
--> statement-breakpoint

-- ruleset_version_is_frozen of game_rules, with what else cites a version. A
-- correction moves the game event off a version, but the lock records keep it
-- and past runs were scored under it, so it has to stay as they saw it even
-- when no locked event uses it any more. As before, a game_events row in
-- locked, scored or final freezes it; so now does any lock record
-- (team_event_states) or scoring run that names it.
CREATE OR REPLACE FUNCTION "ruleset_version_is_frozen"(version_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM "game_events"
    WHERE "ruleset_version_id" = version_id
      AND "status" IN ('locked', 'scored', 'final')
  ) OR EXISTS (
    SELECT 1 FROM "team_event_states" WHERE "ruleset_version_id" = version_id
  ) OR EXISTS (
    SELECT 1 FROM "scoring_runs" WHERE "ruleset_version_id" = version_id
  );
$$;
--> statement-breakpoint

-- teams_slot_limit of game_rules_3, reading the game's latest version that
-- isn't a correction: a correction applies only to the past events re-pointed
-- to it (DM 4.9), so it never sets the limit for new teams. The rest is as it
-- was: a slot runs from 1 to teamsPerUser, checked when a team is added and
-- when its slot or game changes.
CREATE OR REPLACE FUNCTION "teams_slot_limit"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  per_user integer;
BEGIN
  SELECT ("params" ->> 'teamsPerUser')::integer INTO per_user
  FROM "ruleset_versions"
  WHERE "game_id" = NEW."game_id" AND NOT "is_correction"
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
