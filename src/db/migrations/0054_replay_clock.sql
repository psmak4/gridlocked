-- app_now() for a hosted replay (M9 Task 5). On a replay branch with a
-- `replay_offset` setting that is running, the clock is real time minus the
-- offset's seconds, but never before `simulated_clock`: that row is the floor
-- every offset change and every tick writes, so the clock never moves back.
-- Paused, or with no `replay_offset` row, it is `simulated_clock` as before.
-- With no `simulated_clock` row (system mode) it is now() and the offset is
-- never read. A malformed offset raises, as a malformed clock does.
CREATE OR REPLACE FUNCTION app_now() RETURNS timestamptz
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  clock jsonb;
  offset_value jsonb;
  floor_at timestamptz;
BEGIN
  SELECT value INTO clock FROM settings WHERE key = 'simulated_clock';
  IF NOT FOUND THEN
    RETURN now();
  END IF;

  -- `at` must be an ISO-8601 instant with an explicit UTC offset. This keeps
  -- Postgres special inputs ('now', 'today', 'infinity', ...) and offset-less
  -- timestamps (read in the session time zone) from slipping through the cast.
  IF jsonb_typeof(clock) = 'object'
     AND jsonb_typeof(clock -> 'at') = 'string'
     AND (clock ->> 'at') ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$' THEN
    BEGIN
      floor_at := (clock ->> 'at')::timestamptz;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'invalid simulated_clock setting';
    END;
  ELSE
    RAISE EXCEPTION 'invalid simulated_clock setting';
  END IF;

  SELECT value INTO offset_value FROM settings WHERE key = 'replay_offset';
  IF NOT FOUND THEN
    RETURN floor_at;
  END IF;
  IF jsonb_typeof(offset_value) = 'object'
     AND offset_value ->> 'mode' = 'running'
     AND jsonb_typeof(offset_value -> 'seconds') = 'number' THEN
    RETURN greatest(
      floor_at,
      now() - make_interval(secs => (offset_value ->> 'seconds')::double precision)
    );
  END IF;
  IF jsonb_typeof(offset_value) = 'object'
     AND offset_value ->> 'mode' = 'paused' THEN
    RETURN floor_at;
  END IF;
  RAISE EXCEPTION 'invalid replay_offset setting';
END;
$$;
