-- More rules Drizzle cannot express for the fantasy core (DM Part 3):
-- cancelled events (DM 3.9). The game_session_exceptions table is in the
-- generated migration before this one.
--
-- A lineup saved for an event that was cancelled while its window was open
-- still counts (decided for M3): it carries to the next event's lock, so a
-- cancellation never silently undoes a team's changes. team_locked_lineup is
-- where that is decided, for the lock job (lockedLineup) and the chip check
-- alike.

-- The lineup that counts for an event, as of now or at its lock (DM 3.7):
--   the team's latest `regular` or `limitless` version for the event saved
--   before its lock_at, latest by (saved_at, id);
--   else its latest `regular` version saved for a cancelled event of the game
--   from the lock_at of the event before this one (by sequence) to this
--   one's lock_at. Not a `limitless` one: its chip was refunded with the
--   cancellation, and a Limitless lineup only ever lasts one event. Saves for
--   a cancelled event come while it is open, after the event before it has
--   locked, so the bound keeps an older cancellation's saves from coming
--   back over a lineup that locked since;
--   else the base carried forward from the team's earlier events
--   (team_base_state, DM 3.8).
-- Null when the team has none of these. Refused for an event with no
-- sequence (cancelled), as team_base_state is.
CREATE FUNCTION "team_locked_lineup"(team uuid, event uuid) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
  team_game uuid;
  event_sequence integer;
  event_lock timestamptz;
  since timestamptz;
  found_id uuid;
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
  IF FOUND THEN
    RETURN found_id;
  END IF;

  RETURN (SELECT b."base_version_id" FROM team_base_state(team, event) b);
END;
$$;
--> statement-breakpoint

-- chip_play_check of game_rules_7, with the x3 Boost's lineup read from
-- team_locked_lineup: the latest version saved for the event, else one saved
-- for an event cancelled with its window open, else the base. So the target
-- is checked against the lineup the lock job will lock. Every other rule is
-- as it was (the code, the window, the unlock rule, a target only for the x3
-- Boost).
CREATE OR REPLACE FUNCTION "chip_play_check"(play_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  p "chip_plays"%ROWTYPE;
  team_game uuid;
  first_event uuid;
  first_sequence integer;
  event_status text;
  event_sequence integer;
  event_lock timestamptz;
  chip jsonb;
  lineup uuid;
BEGIN
  SELECT * INTO p FROM "chip_plays" WHERE "id" = play_id;
  IF NOT FOUND OR p."status" <> 'played' THEN
    -- Deleted with its team, or refunded, in this transaction.
    RETURN;
  END IF;

  SELECT t."game_id", t."first_event_id" INTO team_game, first_event
  FROM "teams" t WHERE t."id" = p."team_id";
  IF team_game IS DISTINCT FROM p."game_id" THEN
    RAISE EXCEPTION 'chip: unavailable'
      USING ERRCODE = 'GL006',
            DETAIL = format('team %s is not in game %s', p."team_id", p."game_id");
  END IF;

  SELECT ge."status", ge."sequence", e."lock_at",
         (SELECT c FROM jsonb_array_elements(coalesce(rv."params" -> 'chips', '[]'::jsonb)) c
          WHERE c ->> 'code' = p."chip_code" LIMIT 1)
    INTO event_status, event_sequence, event_lock, chip
  FROM "game_events" ge
  JOIN "events" e ON e."id" = ge."event_id"
  JOIN "ruleset_versions" rv ON rv."id" = ge."ruleset_version_id"
  WHERE ge."game_id" = p."game_id" AND ge."event_id" = p."event_id";
  IF NOT FOUND OR event_sequence IS NULL THEN
    RAISE EXCEPTION 'chip: window closed'
      USING ERRCODE = 'GL007',
            DETAIL = format('event %s is not an event of game %s', p."event_id", p."game_id");
  END IF;
  IF chip IS NULL THEN
    RAISE EXCEPTION 'chip: unavailable'
      USING ERRCODE = 'GL006',
            DETAIL = format('the ruleset for event %s has no chip %s', p."event_id", p."chip_code");
  END IF;

  IF chip ->> 'effect' = 'final_fix' THEN
    IF event_status NOT IN ('locked', 'scored')
       OR NOT final_fix_window_open(p."event_id") THEN
      RAISE EXCEPTION 'chip: window closed'
        USING ERRCODE = 'GL007',
              DETAIL = format('Late Call for event %s (%s); the clock says %s',
                              p."event_id", event_status, lineup_window_now());
    END IF;
  ELSIF event_status <> 'open' OR NOT (lineup_window_now() < event_lock) THEN
    RAISE EXCEPTION 'chip: window closed'
      USING ERRCODE = 'GL007',
            DETAIL = format('event %s is %s and locks at %s; the clock says %s',
                            p."event_id", event_status, event_lock, lineup_window_now());
  END IF;

  IF chip ->> 'unlock' = 'after_first_event' THEN
    SELECT ge."sequence" INTO first_sequence
    FROM "game_events" ge
    WHERE ge."game_id" = p."game_id" AND ge."event_id" = first_event;
    IF first_sequence IS NULL OR first_sequence >= event_sequence THEN
      RAISE EXCEPTION 'chip: unavailable'
        USING ERRCODE = 'GL006',
              DETAIL = format('%s unlocks after team %s''s first event (%s)',
                              p."chip_code", p."team_id", first_event);
    END IF;
  ELSIF chip ->> 'unlock' IS DISTINCT FROM 'from_start' THEN
    RAISE EXCEPTION 'chip: unknown unlock rule %', chip ->> 'unlock'
      USING ERRCODE = 'check_violation';
  END IF;

  IF chip ->> 'effect' = 'triple_boost' THEN
    lineup := team_locked_lineup(p."team_id", p."event_id");
    IF p."target_asset_id" IS NULL OR NOT EXISTS (
      SELECT 1
      FROM "lineup_picks" lp
      JOIN "pool_assets" a ON a."id" = lp."asset_id"
      WHERE lp."lineup_version_id" = lineup AND lp."asset_id" = p."target_asset_id"
        AND a."asset_type" = 'driver' AND NOT lp."is_boost"
    ) THEN
      RAISE EXCEPTION 'chip: composition'
        USING ERRCODE = 'GL002',
              DETAIL = format('the x3 Boost target %s is not a driver without the 2x Boost in lineup_versions %s',
                              p."target_asset_id", lineup);
    END IF;
  ELSIF p."target_asset_id" IS NOT NULL THEN
    RAISE EXCEPTION 'chip: composition'
      USING ERRCODE = 'GL002',
            DETAIL = format('%s takes no target', p."chip_code");
  END IF;
END;
$$;
