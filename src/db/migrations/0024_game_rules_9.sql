-- More rules Drizzle cannot express for the fantasy core (DM Part 3):
-- a lineup carried from a cancelled event is checked again at the event it
-- carries to (DM 3.9).
--
-- team_locked_lineup of game_rules_8, with one more rule: a `regular`
-- version saved for a cancelled event counts at this event only if it would
-- pass the save check's availability and budget rules here, against this
-- event's sequence, prices and the team's base going into it. It was checked
-- at the cancelled event, and the next event can differ: a price set for it
-- since, or an asset withdrawn from it. Otherwise the base carries, as if
-- nothing had been saved for the cancelled event; an older cancelled version
-- isn't tried in its place. The rest is as it was:
--   the team's latest `regular` or `limitless` version for the event saved
--   before its lock_at, latest by (saved_at, id);
--   else its latest `regular` version saved for a cancelled event of the game
--   from the lock_at of the event before this one (by sequence) to this
--   one's lock_at (not a `limitless` one: its chip was refunded), when it
--   passes the rules above;
--   else the base carried forward from the team's earlier events
--   (team_base_state, DM 3.8).
-- Null when the team has none of these. Refused for an event with no
-- sequence (cancelled), as team_base_state is.
--
-- The availability rule is lineup_version_check's of game_rules_8: every asset
-- in the team's game, added by this event (game_event_sequence_from), and not
-- withdrawn by it unless the team owns it (it's in the base lineup). The
-- budget rule is its too: the cost at this event's prices is at most
-- team_purchasing_power. An asset with no price here, in the version or the
-- base, fails it rather than raising, so the base carries and the lock job's
-- own checks decide.
CREATE OR REPLACE FUNCTION "team_locked_lineup"(team uuid, event uuid) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  team_game uuid;
  event_sequence integer;
  event_lock timestamptz;
  since timestamptz;
  found_id uuid;
  owned uuid;
  cost integer;
BEGIN
  SELECT t."game_id" INTO team_game FROM "teams" t WHERE t."id" = team;
  SELECT ge."sequence", e."lock_at" INTO event_sequence, event_lock
  FROM "game_events" ge
  JOIN "events" e ON e."id" = ge."event_id"
  WHERE ge."game_id" = team_game AND ge."event_id" = event;
  IF event_sequence IS NULL THEN
    RAISE EXCEPTION 'team_locked_lineup: event % is not a scheduled event of team %''s game',
      event, team
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT lv."id" INTO found_id
  FROM "lineup_versions" lv
  WHERE lv."team_id" = team AND lv."for_event_id" = event
    AND lv."kind" IN ('regular', 'limitless') AND lv."saved_at" < event_lock
  ORDER BY lv."saved_at" DESC, lv."id" DESC
  LIMIT 1;
  IF FOUND THEN
    RETURN found_id;
  END IF;

  SELECT b."base_version_id" INTO owned FROM team_base_state(team, event) b;

  SELECT e."lock_at" INTO since
  FROM "game_events" ge
  JOIN "events" e ON e."id" = ge."event_id"
  WHERE ge."game_id" = team_game AND ge."sequence" < event_sequence
  ORDER BY ge."sequence" DESC
  LIMIT 1;
  SELECT lv."id" INTO found_id
  FROM "lineup_versions" lv
  JOIN "game_events" ge ON ge."game_id" = team_game AND ge."event_id" = lv."for_event_id"
  WHERE lv."team_id" = team AND ge."status" = 'cancelled' AND lv."kind" = 'regular'
    AND lv."saved_at" < event_lock AND (since IS NULL OR lv."saved_at" >= since)
  ORDER BY lv."saved_at" DESC, lv."id" DESC
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN owned;
  END IF;

  -- Availability at this event.
  IF EXISTS (
    SELECT 1
    FROM "lineup_picks" p
    JOIN "pool_assets" a ON a."id" = p."asset_id"
    CROSS JOIN LATERAL (
      SELECT game_event_sequence_from(a."game_id", a."added_from_event_id") AS "sequence") added
    CROSS JOIN LATERAL (
      SELECT game_event_sequence_from(a."game_id", a."withdrawn_from_event_id") AS "sequence") gone
    WHERE p."lineup_version_id" = found_id
      AND (a."game_id" <> team_game
           OR added."sequence" IS NULL
           OR added."sequence" > event_sequence
           OR (((a."status" = 'withdrawn' AND a."withdrawn_from_event_id" IS NULL)
                OR gone."sequence" <= event_sequence)
               AND NOT EXISTS (
                 SELECT 1 FROM "lineup_picks" bp
                 WHERE bp."lineup_version_id" = owned AND bp."asset_id" = a."id")))
  ) THEN
    RETURN owned;
  END IF;

  -- The budget at this event's prices: every asset priced, the version's and
  -- the base's, before team_purchasing_power makes its sum.
  IF EXISTS (
    SELECT 1
    FROM "lineup_picks" p
    LEFT JOIN "asset_prices" ap ON ap."asset_id" = p."asset_id" AND ap."event_id" = event
    WHERE p."lineup_version_id" IN (found_id, owned) AND ap."price" IS NULL
  ) THEN
    RETURN owned;
  END IF;
  SELECT coalesce(sum(ap."price"), 0) INTO cost
  FROM "lineup_picks" p
  JOIN "asset_prices" ap ON ap."asset_id" = p."asset_id" AND ap."event_id" = event
  WHERE p."lineup_version_id" = found_id;
  IF cost > team_purchasing_power(team, event) THEN
    RETURN owned;
  END IF;

  RETURN found_id;
END;
$$;
