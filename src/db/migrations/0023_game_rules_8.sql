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
--> statement-breakpoint

-- The sequence from which something tied to an event takes effect in a game:
-- the event's own, or for a cancelled event (which has none), the sequence of
-- the next non-cancelled event by lock_at. So a pool seeded from a round that
-- is then cancelled is pickable from the next round, and an asset withdrawn
-- from a cancelled round is withdrawn from the next one. Null when there is
-- no such event, or the event isn't one of the game's.
CREATE FUNCTION "game_event_sequence_from"(game uuid, event uuid) RETURNS integer
LANGUAGE sql STABLE AS $$
  SELECT coalesce(ge."sequence", (
           SELECT n."sequence"
           FROM "game_events" n
           JOIN "events" ne ON ne."id" = n."event_id"
           WHERE n."game_id" = game AND n."sequence" IS NOT NULL
             AND ne."lock_at" > e."lock_at"
           ORDER BY ne."lock_at", n."sequence"
           LIMIT 1))
  FROM "game_events" ge
  JOIN "events" e ON e."id" = ge."event_id"
  WHERE ge."game_id" = game AND ge."event_id" = event;
$$;
--> statement-breakpoint

-- lineup_version_check of game_rules_7, with an asset's added-from and
-- withdrawn-from events placed by game_event_sequence_from, so a cancelled
-- one takes effect from the next event instead of making the asset
-- unpickable (added) or never withdrawn (withdrawn). Every rule is as it was
-- (window, Late Call, chips, composition, the x3 Boost, availability, a
-- withdrawn asset kept when owned, budget).
CREATE OR REPLACE FUNCTION "lineup_version_check"(version_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v "lineup_versions"%ROWTYPE;
  team_game uuid;
  event_status text;
  event_sequence integer;
  event_lock timestamptz;
  squad jsonb;
  n_drivers integer;
  n_constructors integer;
  n_boosts integer;
  n_driver_boosts integer;
  owned uuid;
  n_picks integer;
  n_priced integer;
  cost integer;
  power integer;
  race uuid;
  played_effect text;
  played_target uuid;
  locked_version uuid;
  n_swapped integer;
BEGIN
  SELECT * INTO v FROM "lineup_versions" WHERE "id" = version_id;
  IF NOT FOUND THEN
    -- Deleted in this transaction, with its team or by pruning.
    RETURN;
  END IF;

  SELECT t."game_id" INTO team_game FROM "teams" t WHERE t."id" = v."team_id";
  SELECT ge."status", ge."sequence", e."lock_at"
    INTO event_status, event_sequence, event_lock
  FROM "game_events" ge
  JOIN "events" e ON e."id" = ge."event_id"
  WHERE ge."game_id" = team_game AND ge."event_id" = v."for_event_id";
  IF NOT FOUND OR event_sequence IS NULL THEN
    RAISE EXCEPTION 'lineup: window closed'
      USING ERRCODE = 'GL001',
            DETAIL = format('event %s is not an event of the team''s game', v."for_event_id");
  END IF;

  -- Final Fix has its own window, below.
  IF v."kind" IN ('regular', 'limitless')
     AND (event_status <> 'open' OR NOT (lineup_window_now() < event_lock)) THEN
    RAISE EXCEPTION 'lineup: window closed'
      USING ERRCODE = 'GL001',
            DETAIL = format('event %s is %s and locks at %s; the clock says %s',
                            v."for_event_id", event_status, event_lock, lineup_window_now());
  END IF;

  -- A Late Call version: the event has locked, qualifying's results are in
  -- and the race hasn't started (final_fix_window_open), and it applies from
  -- the race.
  IF v."kind" = 'final_fix' THEN
    IF event_status NOT IN ('locked', 'scored')
       OR NOT final_fix_window_open(v."for_event_id") THEN
      RAISE EXCEPTION 'lineup: Late Call window closed'
        USING ERRCODE = 'GL007',
              DETAIL = format('event %s is %s; the clock says %s',
                              v."for_event_id", event_status, lineup_window_now());
    END IF;
    race := event_race_session(v."for_event_id");
    IF v."effective_from_session_id" IS DISTINCT FROM race THEN
      RAISE EXCEPTION 'lineup: a final_fix version applies from the race session %', race
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- The chip played for the event, if any (one per race). A limitless
  -- version needs Blank Cheque played for it, and a final_fix one Late Call.
  SELECT chip_effect(cp."game_id", cp."event_id", cp."chip_code"), cp."target_asset_id"
    INTO played_effect, played_target
  FROM "chip_plays" cp
  WHERE cp."team_id" = v."team_id" AND cp."event_id" = v."for_event_id"
    AND cp."status" = 'played';
  IF (v."kind" = 'limitless' AND played_effect IS DISTINCT FROM 'limitless')
     OR (v."kind" = 'final_fix' AND played_effect IS DISTINCT FROM 'final_fix') THEN
    RAISE EXCEPTION 'lineup: chip unavailable'
      USING ERRCODE = 'GL006',
            DETAIL = format('a %s version needs its chip played for event %s',
                            v."kind", v."for_event_id");
  END IF;

  SELECT rv."params" -> 'squad' INTO squad
  FROM "game_events" ge
  JOIN "ruleset_versions" rv ON rv."id" = ge."ruleset_version_id"
  WHERE ge."game_id" = team_game AND ge."event_id" = v."for_event_id";
  IF squad IS NULL THEN
    RAISE EXCEPTION 'lineup: the ruleset has no squad rules'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT count(*) FILTER (WHERE a."asset_type" = 'driver'),
         count(*) FILTER (WHERE a."asset_type" = 'constructor'),
         count(*) FILTER (WHERE p."is_boost"),
         count(*) FILTER (WHERE p."is_boost" AND a."asset_type" = 'driver')
    INTO n_drivers, n_constructors, n_boosts, n_driver_boosts
  FROM "lineup_picks" p
  JOIN "pool_assets" a ON a."id" = p."asset_id"
  WHERE p."lineup_version_id" = v."id";
  IF n_drivers <> (squad ->> 'drivers')::integer
     OR n_constructors <> (squad ->> 'constructors')::integer
     OR n_boosts <> (squad ->> 'boosts')::integer
     OR n_driver_boosts <> n_boosts THEN
    RAISE EXCEPTION 'lineup: composition'
      USING ERRCODE = 'GL002',
            DETAIL = format('%s drivers, %s constructors, %s Boosts (%s on drivers); the squad is %s',
                            n_drivers, n_constructors, n_boosts, n_driver_boosts, squad);
  END IF;

  -- With the x3 Boost played, its target stays in the lineup as a driver
  -- without the 2x Boost, on every save (DM 3.9).
  IF played_effect = 'triple_boost' AND NOT EXISTS (
    SELECT 1
    FROM "lineup_picks" p
    JOIN "pool_assets" a ON a."id" = p."asset_id"
    WHERE p."lineup_version_id" = v."id" AND p."asset_id" = played_target
      AND a."asset_type" = 'driver' AND NOT p."is_boost"
  ) THEN
    RAISE EXCEPTION 'lineup: composition'
      USING ERRCODE = 'GL002',
            DETAIL = format('the x3 Boost target %s must stay in lineup_versions %s, without the 2x Boost',
                            played_target, v."id");
  END IF;

  -- A Late Call is the event's locked lineup with one asset swapped. A kept
  -- asset keeps its Boost or lack of one; the incoming asset has the Boost
  -- exactly when the one it replaced did (DM 3.0).
  IF v."kind" = 'final_fix' THEN
    SELECT s."locked_version_id" INTO locked_version
    FROM "team_event_states" s
    WHERE s."team_id" = v."team_id" AND s."event_id" = v."for_event_id";
    IF NOT FOUND THEN
      RAISE EXCEPTION 'lineup: chip unavailable'
        USING ERRCODE = 'GL006',
              DETAIL = format('team %s has no lock record for event %s', v."team_id", v."for_event_id");
    END IF;
    SELECT count(*) INTO n_swapped
    FROM "lineup_picks" p
    WHERE p."lineup_version_id" = v."id"
      AND NOT EXISTS (
        SELECT 1 FROM "lineup_picks" lp
        WHERE lp."lineup_version_id" = locked_version AND lp."asset_id" = p."asset_id");
    IF n_swapped > 1 OR EXISTS (
      SELECT 1
      FROM "lineup_picks" p
      WHERE p."lineup_version_id" = v."id"
        AND p."is_boost" IS DISTINCT FROM coalesce(
          (SELECT lp."is_boost" FROM "lineup_picks" lp
           WHERE lp."lineup_version_id" = locked_version AND lp."asset_id" = p."asset_id"),
          EXISTS (
            SELECT 1 FROM "lineup_picks" lp
            WHERE lp."lineup_version_id" = locked_version AND lp."is_boost"
              AND NOT EXISTS (
                SELECT 1 FROM "lineup_picks" q
                WHERE q."lineup_version_id" = v."id" AND q."asset_id" = lp."asset_id")))
    ) THEN
      RAISE EXCEPTION 'lineup: composition'
        USING ERRCODE = 'GL002',
              DETAIL = format('lineup_versions %s swaps %s assets of locked version %s, or moves its Boost',
                              v."id", n_swapped, locked_version);
    END IF;
  END IF;

  SELECT b."base_version_id" INTO owned
  FROM team_base_state(v."team_id", v."for_event_id") b;
  IF EXISTS (
    SELECT 1
    FROM "lineup_picks" p
    JOIN "pool_assets" a ON a."id" = p."asset_id"
    CROSS JOIN LATERAL (
      SELECT game_event_sequence_from(a."game_id", a."added_from_event_id") AS "sequence") added
    CROSS JOIN LATERAL (
      SELECT game_event_sequence_from(a."game_id", a."withdrawn_from_event_id") AS "sequence") gone
    WHERE p."lineup_version_id" = v."id"
      AND (a."game_id" <> team_game
           OR added."sequence" IS NULL
           OR added."sequence" > event_sequence
           OR (((a."status" = 'withdrawn' AND a."withdrawn_from_event_id" IS NULL)
                OR gone."sequence" <= event_sequence)
               AND NOT EXISTS (
                 SELECT 1 FROM "lineup_picks" bp
                 WHERE bp."lineup_version_id" = owned AND bp."asset_id" = a."id")))
  ) THEN
    RAISE EXCEPTION 'lineup: asset unavailable'
      USING ERRCODE = 'GL003',
            DETAIL = format('lineup_versions %s has an asset the team can''t pick for event %s', v."id", v."for_event_id");
  END IF;

  IF v."kind" <> 'limitless' THEN
    SELECT count(*), count(ap."price"), coalesce(sum(ap."price"), 0)
      INTO n_picks, n_priced, cost
    FROM "lineup_picks" p
    LEFT JOIN "asset_prices" ap
      ON ap."asset_id" = p."asset_id" AND ap."event_id" = v."for_event_id"
    WHERE p."lineup_version_id" = v."id";
    IF n_priced < n_picks THEN
      RAISE EXCEPTION 'lineup: % assets have no price at event %',
        n_picks - n_priced, v."for_event_id"
        USING ERRCODE = 'check_violation';
    END IF;
    power := team_purchasing_power(v."team_id", v."for_event_id");
    IF cost > power THEN
      RAISE EXCEPTION 'lineup: over budget'
        USING ERRCODE = 'GL004',
              DETAIL = format('lineup_versions %s costs %s; team %s can spend %s at event %s',
                              v."id", cost, v."team_id", power, v."for_event_id");
    END IF;
  END IF;
END;
$$;
--> statement-breakpoint

-- The price freeze of game_rules_5 and game_rules_2, with `cancelled` added:
-- a cancelled event's prices stay fixed, since lineups were saved against
-- them and the next event carries them (DM 3.9). So none of its prices can be
-- changed or removed (asset_price_is_fixed), and none added
-- (asset_price_is_frozen). The trigger that calls them is unchanged.
CREATE OR REPLACE FUNCTION "asset_price_is_fixed"(asset uuid, event uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM "pool_assets" a
    JOIN "game_events" ge ON ge."game_id" = a."game_id"
    WHERE a."id" = asset
      AND ge."event_id" = event
      AND ge."status" IN ('open', 'locked', 'scored', 'final', 'cancelled')
  );
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "asset_price_is_frozen"(asset uuid, event uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM "pool_assets" a
    JOIN "game_events" ge ON ge."game_id" = a."game_id"
    WHERE a."id" = asset
      AND ge."event_id" = event
      AND ge."status" IN ('locked', 'scored', 'final', 'cancelled')
  );
$$;
