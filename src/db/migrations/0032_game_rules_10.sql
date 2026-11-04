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
