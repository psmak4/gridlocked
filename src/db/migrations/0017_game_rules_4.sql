-- More rules Drizzle cannot express for the fantasy core (DM Part 3). The
-- lineup tables are in the generated migration before this one.

-- saved_at (DM 3.7) is the database's clock, never the client's: whatever an
-- insert says, the row gets app_now(). That is what the lock compares.
CREATE FUNCTION "lineup_versions_set_saved_at"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW."saved_at" := app_now();
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "lineup_versions_set_saved_at"
  BEFORE INSERT ON "lineup_versions"
  FOR EACH ROW EXECUTE FUNCTION "lineup_versions_set_saved_at"();
--> statement-breakpoint

-- A saved version is never rewritten (DM 3.7: versioned, never overwritten).
-- Its team, event, kind, session and saved_at are what the lock was decided on.
-- based_on_version_id is left out: deleting an old version nulls it.
CREATE FUNCTION "lineup_versions_immutable"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."team_id" IS DISTINCT FROM OLD."team_id"
     OR NEW."for_event_id" IS DISTINCT FROM OLD."for_event_id"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."effective_from_session_id" IS DISTINCT FROM OLD."effective_from_session_id"
     OR NEW."saved_at" IS DISTINCT FROM OLD."saved_at" THEN
    RAISE EXCEPTION 'lineup versions are not rewritten: UPDATE refused'
      USING ERRCODE = 'restrict_violation',
            DETAIL = format('lineup_versions %s is already saved', OLD."id");
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "lineup_versions_immutable"
  BEFORE UPDATE OF "team_id", "for_event_id", "kind", "effective_from_session_id", "saved_at"
  ON "lineup_versions"
  FOR EACH ROW EXECUTE FUNCTION "lineup_versions_immutable"();
--> statement-breakpoint

-- What the database checks on a lineup version (DM 3.7), in this order. Each
-- refusal has its own SQLSTATE, so the game layer maps it to an error code
-- rather than matching message text:
--   GL001 window_closed      the event isn't the game's open one, or app_now()
--                            is at or past its lock_at
--   GL002 composition        squad counts or the Boost, from the ruleset
--                            version in force for the event
--   GL003 asset_unavailable  not in the team's game, added from a later event,
--                            or withdrawn at or before the event
-- Budget, and keeping a withdrawn asset a team already owns, are checked later.
-- Order is by game_events.sequence, the game's own order of events.
CREATE FUNCTION "lineup_version_check"(version_id uuid) RETURNS void
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
     AND (event_status <> 'open' OR NOT (app_now() < event_lock)) THEN
    RAISE EXCEPTION 'lineup: window closed'
      USING ERRCODE = 'GL001',
            DETAIL = format('event %s is %s and locks at %s; the clock says %s',
                            v."for_event_id", event_status, event_lock, app_now());
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
           OR (a."status" = 'withdrawn' AND a."withdrawn_from_event_id" IS NULL)
           OR gone."sequence" <= event_sequence)
  ) THEN
    RAISE EXCEPTION 'lineup: asset unavailable'
      USING ERRCODE = 'GL003',
            DETAIL = format('lineup_versions %s has an asset the team can''t pick for event %s', v."id", v."for_event_id");
  END IF;
END;
$$;
--> statement-breakpoint

-- The checks run when the transaction commits, once the version and all its
-- picks are in. A save is one transaction, so a refusal surfaces at COMMIT.
-- A pick changed or removed later runs the check again, so a locked version
-- can't be edited either; a pick deleted along with its version has nothing
-- left to check.
CREATE FUNCTION "lineup_versions_check"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "lineup_version_check"(NEW."id");
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "lineup_versions_check"
  AFTER INSERT ON "lineup_versions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "lineup_versions_check"();
--> statement-breakpoint

CREATE FUNCTION "lineup_picks_check"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'DELETE' THEN
    PERFORM "lineup_version_check"(NEW."lineup_version_id");
  END IF;
  IF TG_OP = 'DELETE'
     OR (TG_OP = 'UPDATE' AND NEW."lineup_version_id" <> OLD."lineup_version_id") THEN
    PERFORM "lineup_version_check"(OLD."lineup_version_id");
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "lineup_picks_check"
  AFTER INSERT OR UPDATE OR DELETE ON "lineup_picks"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "lineup_picks_check"();
--> statement-breakpoint

-- No lock_at can be moved to a time already past (DM 3.11), for an event that
-- has a game row, so no saved lineup is retroactively late. The calendar sync
-- already refuses to move a lock that has passed (lock_passed_changed); this
-- is the backstop for a future lock moved into the past. Writing the same
-- value again is not a move.
CREATE FUNCTION "events_lock_at_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."lock_at" IS DISTINCT FROM OLD."lock_at"
     AND NEW."lock_at" <= app_now()
     AND EXISTS (SELECT 1 FROM "game_events" WHERE "event_id" = NEW."id") THEN
    RAISE EXCEPTION 'events: lock_at can''t move to a time already past'
      USING ERRCODE = 'restrict_violation',
            DETAIL = format('events %s: %s is at or before the clock, %s', NEW."id", NEW."lock_at", app_now());
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "events_lock_at_guard"
  BEFORE UPDATE OF "lock_at" ON "events"
  FOR EACH ROW EXECUTE FUNCTION "events_lock_at_guard"();
