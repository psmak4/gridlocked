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

  IF jsonb_typeof(clock) = 'object' AND jsonb_typeof(clock -> 'at') = 'string' THEN
    BEGIN
      RETURN (clock ->> 'at')::timestamptz;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'invalid simulated_clock setting';
    END;
  END IF;

  RAISE EXCEPTION 'invalid simulated_clock setting';
END;
$$;
