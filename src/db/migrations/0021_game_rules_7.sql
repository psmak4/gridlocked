-- More rules Drizzle cannot express for the fantasy core (DM Part 3): the
-- chips (DM 3.9). The chip_plays table and team_event_states.chip_play_id are
-- in the generated migration before this one. Chip refusals have their own
-- SQLSTATEs, so the game layer maps them to an error code:
--   GL006 chip_unavailable    not a chip of the event's ruleset, not unlocked
--                             yet for the team, or a version that needs a
--                             chip played (limitless, final_fix) without it
--   GL007 chip_window_closed  outside the play window: before the lock for
--                             every chip but Late Call, which has its own
-- A bad x3 Boost target is GL002 composition, as the lineup check says it.

-- What a chip does, by its code in the event's ruleset params (`effect`), or
-- null when the ruleset has no such chip.
CREATE FUNCTION "chip_effect"(game uuid, event uuid, code text) RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT c ->> 'effect'
  FROM "game_events" ge
  JOIN "ruleset_versions" rv ON rv."id" = ge."ruleset_version_id"
  CROSS JOIN LATERAL jsonb_array_elements(coalesce(rv."params" -> 'chips', '[]'::jsonb)) c
  WHERE ge."game_id" = game AND ge."event_id" = event AND c ->> 'code' = code
  LIMIT 1;
$$;
--> statement-breakpoint

-- An event's race: the session a Late Call applies from.
CREATE FUNCTION "event_race_session"(event uuid) RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT s."id" FROM "sessions" s
  WHERE s."event_id" = event AND s."kind" = 'race'
  ORDER BY s."sequence"
  LIMIT 1;
$$;
--> statement-breakpoint

-- The Late Call (Final Fix) window (DM 3.7): it opens when qualifying's
-- results arrive, that is when its session_result_state has left `awaiting`,
-- and closes at the race's scheduled start. Qualifying, not sprint
-- qualifying, so on a sprint weekend it opens after the sprint. Not
-- `sessions.status = 'completed'`, which nothing sets; not qualifying's
-- scheduled end, which a rain delay would pass with Q1 already seen. The clock
-- is the window's (lineup_window_now()), as for every save.
CREATE FUNCTION "final_fix_window_open"(event uuid) RETURNS boolean
LANGUAGE sql AS $$
  SELECT EXISTS (
           SELECT 1
           FROM "sessions" q
           JOIN "session_result_state" r ON r."session_id" = q."id"
           WHERE q."event_id" = event AND q."kind" = 'qualifying'
             AND r."status" <> 'awaiting')
     AND coalesce(
           lineup_window_now() < (SELECT s."scheduled_start" FROM "sessions" s
                                  WHERE s."id" = event_race_session(event)),
           false);
$$;
--> statement-breakpoint

-- played_at (DM 3.9) is the database's clock, never the client's, and a play
-- starts out `played`.
CREATE FUNCTION "chip_plays_set_played_at"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" <> 'played' THEN
    RAISE EXCEPTION 'chip_plays: a chip is played, not inserted as %', NEW."status"
      USING ERRCODE = 'check_violation';
  END IF;
  NEW."played_at" := app_now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "chip_plays_set_played_at"
  BEFORE INSERT ON "chip_plays"
  FOR EACH ROW EXECUTE FUNCTION "chip_plays_set_played_at"();
--> statement-breakpoint

-- What the database checks on a chip play (DM 3.9), when the transaction
-- commits, so the window is judged by the clock then, as a save's is. Once
-- per season and one per race are the two partial unique indexes.
--   the code is a chip of the event's ruleset (GL006);
--   the window (GL007): Late Call once the event has locked and while
--   final_fix_window_open; every other chip while the event is the game's
--   open one and before its lock_at;
--   the unlock rule (GL006): an `after_first_event` chip only at an event
--   later, by sequence, than the team's first_event_id;
--   the x3 Boost (GL002): its target is a driver in the team's lineup for the
--   event (its latest version saved for it, or else its base), without the 2x
--   Boost; no other chip has a target.
CREATE FUNCTION "chip_play_check"(play_id uuid) RETURNS void
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
    SELECT lv."id" INTO lineup
    FROM "lineup_versions" lv
    WHERE lv."team_id" = p."team_id" AND lv."for_event_id" = p."event_id"
      AND lv."kind" IN ('regular', 'limitless')
    ORDER BY lv."saved_at" DESC, lv."id" DESC
    LIMIT 1;
    IF NOT FOUND THEN
      SELECT b."base_version_id" INTO lineup
      FROM team_base_state(p."team_id", p."event_id") b;
    END IF;
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
CREATE FUNCTION "chip_plays_check"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "chip_play_check"(NEW."id");
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "chip_plays_check"
  AFTER INSERT ON "chip_plays"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "chip_plays_check"();
--> statement-breakpoint

-- A played chip can't be cancelled (DM 3.0, 3.9): a play is never deleted or
-- rewritten, and its one change is `played` to `refunded`, which the system
-- makes for an event that was cancelled. A refund is final. The one delete is
-- the cascade from a team deleted outright before its first lock, when the
-- team is already gone.
CREATE FUNCTION "chip_plays_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF EXISTS (SELECT 1 FROM "teams" WHERE "id" = OLD."team_id") THEN
      RAISE EXCEPTION 'chip plays are not deleted: DELETE refused'
        USING ERRCODE = 'restrict_violation',
              DETAIL = format('chip_plays %s is %s', OLD."id", OLD."status");
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."team_id" IS DISTINCT FROM OLD."team_id"
     OR NEW."game_id" IS DISTINCT FROM OLD."game_id"
     OR NEW."chip_code" IS DISTINCT FROM OLD."chip_code"
     OR NEW."event_id" IS DISTINCT FROM OLD."event_id"
     OR NEW."target_asset_id" IS DISTINCT FROM OLD."target_asset_id"
     OR NEW."played_at" IS DISTINCT FROM OLD."played_at" THEN
    RAISE EXCEPTION 'chip plays are not rewritten: UPDATE refused'
      USING ERRCODE = 'restrict_violation',
            DETAIL = format('chip_plays %s is already played', OLD."id");
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status"
     AND (OLD."status" <> 'played' OR NEW."status" <> 'refunded'
          OR NOT EXISTS (
            SELECT 1 FROM "game_events" ge
            WHERE ge."game_id" = OLD."game_id" AND ge."event_id" = OLD."event_id"
              AND ge."status" = 'cancelled')) THEN
    RAISE EXCEPTION 'chip plays are not undone: only a cancelled event''s chips are refunded'
      USING ERRCODE = 'restrict_violation',
            DETAIL = format('chip_plays %s: %s to %s', OLD."id", OLD."status", NEW."status");
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "chip_plays_guard"
  BEFORE UPDATE OR DELETE ON "chip_plays"
  FOR EACH ROW EXECUTE FUNCTION "chip_plays_guard"();
--> statement-breakpoint

-- team_base_state of game_rules_5, with the Limitless week read from the
-- chip: a week is a Limitless one when the row's chip_play_id is a played
-- chip whose effect is `limitless`, whatever kind of version locked (a team
-- may play Blank Cheque and keep a lineup it saved before). The rest is as it
-- was.
CREATE OR REPLACE FUNCTION "team_base_state"(team_id uuid, event_id uuid)
RETURNS TABLE(base_version_id uuid, bank integer, carry_in integer, is_first boolean)
LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
  team_game uuid;
  event_sequence integer;
  prev record;
  bank_before integer;
BEGIN
  SELECT t."game_id" INTO team_game FROM "teams" t WHERE t."id" = team_base_state.team_id;
  SELECT ge."sequence" INTO event_sequence
  FROM "game_events" ge
  WHERE ge."game_id" = team_game AND ge."event_id" = team_base_state.event_id;
  IF event_sequence IS NULL THEN
    RAISE EXCEPTION 'team_base_state: event % is not a scheduled event of team %''s game',
      team_base_state.event_id, team_base_state.team_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT s."base_version_id", s."locked_version_id", s."bank", s."carry_over_out",
         ge."sequence", chip_effect(cp."game_id", cp."event_id", cp."chip_code") AS "effect"
    INTO prev
  FROM "team_event_states" s
  JOIN "game_events" ge ON ge."game_id" = s."game_id" AND ge."event_id" = s."event_id"
  LEFT JOIN "chip_plays" cp ON cp."id" = s."chip_play_id" AND cp."status" = 'played'
  WHERE s."team_id" = team_base_state.team_id AND ge."sequence" < event_sequence
  ORDER BY ge."sequence" DESC
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::uuid, NULL::integer, 0, true;
    RETURN;
  END IF;

  IF prev."effect" = 'limitless' THEN
    SELECT s."bank" INTO bank_before
    FROM "team_event_states" s
    JOIN "game_events" ge ON ge."game_id" = s."game_id" AND ge."event_id" = s."event_id"
    WHERE s."team_id" = team_base_state.team_id AND ge."sequence" < prev."sequence"
    ORDER BY ge."sequence" DESC
    LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'team_base_state: team % has a Limitless week with no event before it',
        team_base_state.team_id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN QUERY SELECT prev."base_version_id", bank_before, 0, false;
    RETURN;
  END IF;

  RETURN QUERY SELECT prev."locked_version_id", prev."bank", prev."carry_over_out"::integer, false;
END;
$$;
--> statement-breakpoint

-- The lineup check of game_rules_5, with the chip rules (DM 3.7, 3.9). Every
-- rule there is kept as it was (window, composition, availability, a
-- withdrawn asset kept when owned, budget); added:
--   a final_fix version is saved in the Late Call window (GL007), applies
--   from the event's race, and needs Late Call played (GL006); it is the
--   event's locked lineup with one asset swapped, the Boost following the
--   asset it was on or moving to the incoming one (GL002);
--   a limitless version needs Blank Cheque played for its event (GL006);
--   with the x3 Boost played, its target stays in the lineup as a driver
--   without the 2x Boost (GL002).
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
    LEFT JOIN "game_events" added
      ON added."game_id" = a."game_id" AND added."event_id" = a."added_from_event_id"
    LEFT JOIN "game_events" gone
      ON gone."game_id" = a."game_id" AND gone."event_id" = a."withdrawn_from_event_id"
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
