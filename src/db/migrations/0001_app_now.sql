-- app_now(): the database clock (DM 3.7). now() in production; on a replay
-- branch, the time in the `simulated_clock` setting. A malformed setting
-- raises instead of silently falling back to real time.
CREATE OR REPLACE FUNCTION app_now() RETURNS timestamptz
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  clock jsonb;
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
      RETURN (clock ->> 'at')::timestamptz;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'invalid simulated_clock setting';
    END;
  END IF;

  RAISE EXCEPTION 'invalid simulated_clock setting';
END;
$$;
