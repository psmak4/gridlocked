-- Rules Drizzle cannot express for the ingestion and results tables (DM Part 2).
-- The tables, CHECKs and partial indexes are in the generated migration before
-- this one.

-- results.session_kind (DM 2.4): a copy of sessions.kind, so the CHECKs on grid
-- and the q times can see the session kind. Always recomputed, on insert and on
-- any update, so neither a caller nor a change of session_id can leave it stale.
-- A session that does not exist is a foreign key violation, reported here
-- because this trigger runs before the foreign key check would.
CREATE FUNCTION "results_set_session_kind"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  SELECT "kind" INTO NEW."session_kind" FROM "sessions" WHERE "id" = NEW."session_id";
  IF NOT FOUND THEN
    RAISE EXCEPTION 'results.session_id % does not exist in sessions', NEW."session_id"
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "results_set_session_kind"
  BEFORE INSERT OR UPDATE ON "results"
  FOR EACH ROW EXECUTE FUNCTION "results_set_session_kind"();
--> statement-breakpoint

-- The blocking-review guard (DM 2.9): a session's status can't become
-- 'provisional' or 'final' while it has an open blocking review item. Checked
-- on insert, and on update only when the status or the session_id changes (so a
-- final row can't be re-keyed onto a session with an open blocking item), so
-- other column updates (poll_attempts, version) on a provisional session still
-- work.
-- Callers make the status change in the same transaction as their own check.
CREATE FUNCTION "session_result_state_guard_blocking"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."status" IN ('provisional', 'final')
     AND (
       TG_OP = 'INSERT'
       OR OLD."status" IS DISTINCT FROM NEW."status"
       OR OLD."session_id" IS DISTINCT FROM NEW."session_id"
     )
     AND EXISTS (
       SELECT 1 FROM "review_items"
       WHERE "session_id" = NEW."session_id"
         AND "status" = 'open'
         AND "severity" = 'blocking'
     )
  THEN
    RAISE EXCEPTION 'open blocking review item'
      USING ERRCODE = 'integrity_constraint_violation',
            DETAIL = format('session %s cannot become %s', NEW."session_id", NEW."status");
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "session_result_state_guard_blocking"
  BEFORE INSERT OR UPDATE OF "status", "session_id" ON "session_result_state"
  FOR EACH ROW EXECUTE FUNCTION "session_result_state_guard_blocking"();
--> statement-breakpoint

-- effective_results (DM 2.7): what scoring, pages and posts read. Provider rows
-- with active overrides applied:
--   patch    replaces only the columns named in `fields` (a key set to JSON null
--            sets the column to null);
--   suppress removes the provider row;
--   insert   adds a row built from `fields`. If the provider also has a row for
--            that driver, the insert wins and the provider row is dropped, so
--            there is one row per driver (DM 2.6: manual rows stay until an admin
--            decides).
-- `overridden` and `override_reason` say which rows an admin touched. For an
-- inserted row, snapshot_id is null (no provider snapshot behind it).
CREATE VIEW "effective_results" AS
SELECT
    r.session_id,
    r.driver_id,
    r.snapshot_id,
    r.session_kind,
    CASE WHEN o.fields ? 'constructor_id' THEN (o.fields ->> 'constructor_id')::uuid ELSE r.constructor_id END AS constructor_id,
    CASE WHEN o.fields ? 'car_number' THEN (o.fields ->> 'car_number')::integer ELSE r.car_number END AS car_number,
    CASE WHEN o.fields ? 'position' THEN (o.fields ->> 'position')::integer ELSE r.position END AS position,
    CASE WHEN o.fields ? 'classification' THEN (o.fields ->> 'classification')::text ELSE r.classification END AS classification,
    CASE WHEN o.fields ? 'provider_status' THEN (o.fields ->> 'provider_status')::text ELSE r.provider_status END AS provider_status,
    CASE WHEN o.fields ? 'provider_position_text' THEN (o.fields ->> 'provider_position_text')::text ELSE r.provider_position_text END AS provider_position_text,
    CASE WHEN o.fields ? 'grid' THEN (o.fields ->> 'grid')::integer ELSE r.grid END AS grid,
    CASE WHEN o.fields ? 'pit_lane_start' THEN COALESCE((o.fields ->> 'pit_lane_start')::boolean, false) ELSE r.pit_lane_start END AS pit_lane_start,
    CASE WHEN o.fields ? 'laps' THEN (o.fields ->> 'laps')::integer ELSE r.laps END AS laps,
    CASE WHEN o.fields ? 'time_ms' THEN (o.fields ->> 'time_ms')::bigint ELSE r.time_ms END AS time_ms,
    CASE WHEN o.fields ? 'fastest_lap_rank' THEN (o.fields ->> 'fastest_lap_rank')::integer ELSE r.fastest_lap_rank END AS fastest_lap_rank,
    CASE WHEN o.fields ? 'fastest_lap_ms' THEN (o.fields ->> 'fastest_lap_ms')::integer ELSE r.fastest_lap_ms END AS fastest_lap_ms,
    CASE WHEN o.fields ? 'q1_ms' THEN (o.fields ->> 'q1_ms')::integer ELSE r.q1_ms END AS q1_ms,
    CASE WHEN o.fields ? 'q2_ms' THEN (o.fields ->> 'q2_ms')::integer ELSE r.q2_ms END AS q2_ms,
    CASE WHEN o.fields ? 'q3_ms' THEN (o.fields ->> 'q3_ms')::integer ELSE r.q3_ms END AS q3_ms,
    CASE WHEN o.fields ? 'official_points' THEN (o.fields ->> 'official_points')::numeric(4,1) ELSE r.official_points END AS official_points,
    (o.id IS NOT NULL) AS overridden,
    o.reason AS override_reason
FROM "results" r
LEFT JOIN "result_overrides" o
  ON o.session_id = r.session_id
 AND o.driver_id = r.driver_id
 AND o.revoked_at IS NULL
WHERE o.kind IS NULL OR o.kind = 'patch'
UNION ALL
SELECT
    o.session_id,
    o.driver_id,
    NULL::uuid AS snapshot_id,
    s.kind AS session_kind,
    (o.fields ->> 'constructor_id')::uuid AS constructor_id,
    (o.fields ->> 'car_number')::integer AS car_number,
    (o.fields ->> 'position')::integer AS position,
    (o.fields ->> 'classification')::text AS classification,
    (o.fields ->> 'provider_status')::text AS provider_status,
    (o.fields ->> 'provider_position_text')::text AS provider_position_text,
    (o.fields ->> 'grid')::integer AS grid,
    COALESCE((o.fields ->> 'pit_lane_start')::boolean, false) AS pit_lane_start,
    (o.fields ->> 'laps')::integer AS laps,
    (o.fields ->> 'time_ms')::bigint AS time_ms,
    (o.fields ->> 'fastest_lap_rank')::integer AS fastest_lap_rank,
    (o.fields ->> 'fastest_lap_ms')::integer AS fastest_lap_ms,
    (o.fields ->> 'q1_ms')::integer AS q1_ms,
    (o.fields ->> 'q2_ms')::integer AS q2_ms,
    (o.fields ->> 'q3_ms')::integer AS q3_ms,
    (o.fields ->> 'official_points')::numeric(4,1) AS official_points,
    true AS overridden,
    o.reason AS override_reason
FROM "result_overrides" o
JOIN "sessions" s ON s.id = o.session_id
WHERE o.kind = 'insert' AND o.revoked_at IS NULL;
