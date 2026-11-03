-- More rules Drizzle cannot express for the fantasy core (DM Part 3). The
-- team_event_states table is in the generated migration before this one.

-- Where a team stands going into an event (DM 3.8), from its latest
-- team_event_states row before the event in the game's order (sequence):
--   base_version_id  the lineup its transfers are counted against, and whose
--                    assets it owns: that row's locked version
--   bank             what that row left unspent
--   carry_in         that row's carry_over_out
--   is_first         true when there is no such row: the team's first event,
--                    with no base, no bank, and the whole budget to spend
-- After a Limitless week the team reverts: the base is the Limitless row's own
-- base (the lineup before it), the bank is the bank of the row before that one,
-- and nothing carries in. A Limitless week is one whose locked version is
-- `limitless`. It is never a team's first event (the chip unlocks after it).
-- Rows exist only for events that locked, so a cancelled event is skipped.
CREATE FUNCTION "team_base_state"(team_id uuid, event_id uuid)
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
         ge."sequence", v."kind"
    INTO prev
  FROM "team_event_states" s
  JOIN "game_events" ge ON ge."game_id" = s."game_id" AND ge."event_id" = s."event_id"
  JOIN "lineup_versions" v ON v."id" = s."locked_version_id"
  WHERE s."team_id" = team_base_state.team_id AND ge."sequence" < event_sequence
  ORDER BY ge."sequence" DESC
  LIMIT 1;
  IF NOT FOUND THEN
    RETURN QUERY SELECT NULL::uuid, NULL::integer, 0, true;
    RETURN;
  END IF;

  IF prev."kind" = 'limitless' THEN
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

-- What a team can spend at an event (DM 3.8), in units of $0.1M: the ruleset's
-- budget at its first event, and after that the bank plus its base lineup's
-- assets at this event's prices. Owned assets are sold at today's price, so a
-- rise raises it and a fall lowers it, and keeping the base lineup is always
-- affordable. The one place this sum is made: the save check and the lock job
-- both call it. An owned asset with no price at the event is an error, never a
-- price of 0.
CREATE FUNCTION "team_purchasing_power"(team_id uuid, event_id uuid) RETURNS integer
LANGUAGE plpgsql AS $$
#variable_conflict use_column
DECLARE
  base record;
  budget integer;
  n_owned integer;
  n_priced integer;
  owned_value integer;
BEGIN
  SELECT * INTO base
  FROM team_base_state(team_purchasing_power.team_id, team_purchasing_power.event_id);

  IF base."is_first" THEN
    SELECT (rv."params" ->> 'budget')::integer INTO budget
    FROM "teams" t
    JOIN "game_events" ge ON ge."game_id" = t."game_id"
    JOIN "ruleset_versions" rv ON rv."id" = ge."ruleset_version_id"
    WHERE t."id" = team_purchasing_power.team_id
      AND ge."event_id" = team_purchasing_power.event_id;
    IF budget IS NULL THEN
      RAISE EXCEPTION 'team_purchasing_power: the ruleset for event % has no budget',
        team_purchasing_power.event_id
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN budget;
  END IF;

  SELECT count(*), count(ap."price"), coalesce(sum(ap."price"), 0)
    INTO n_owned, n_priced, owned_value
  FROM "lineup_picks" p
  LEFT JOIN "asset_prices" ap
    ON ap."asset_id" = p."asset_id" AND ap."event_id" = team_purchasing_power.event_id
  WHERE p."lineup_version_id" = base."base_version_id";
  IF n_priced < n_owned THEN
    RAISE EXCEPTION 'team_purchasing_power: % of team %''s assets have no price at event %',
      n_owned - n_priced, team_purchasing_power.team_id, team_purchasing_power.event_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN base."bank" + owned_value;
END;
$$;
--> statement-breakpoint

-- The lineup check of game_rules_4, with two more rules (DM 3.7, 3.8):
--   a withdrawn asset can still be picked when the team owns it, that is when
--   it is in the base lineup (team_base_state), so owners keep it; once sold
--   and locked it can't come back;
--   GL004 over_budget  the version's cost at its event's prices is more than
--                      team_purchasing_power. A `limitless` version skips it.
-- An asset with no price at the event is a data error, not the player's.
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

  -- Final Fix has its own window (Task 7).
  IF v."kind" IN ('regular', 'limitless')
     AND (event_status <> 'open' OR NOT (lineup_window_now() < event_lock)) THEN
    RAISE EXCEPTION 'lineup: window closed'
      USING ERRCODE = 'GL001',
            DETAIL = format('event %s is %s and locks at %s; the clock says %s',
                            v."for_event_id", event_status, event_lock, lineup_window_now());
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
