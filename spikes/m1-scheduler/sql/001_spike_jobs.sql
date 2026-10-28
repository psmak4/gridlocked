CREATE TABLE IF NOT EXISTS spike_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  dedupe_key text NOT NULL UNIQUE,
  run_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  claimed_at timestamptz,
  done_at timestamptz
);
CREATE INDEX IF NOT EXISTS spike_jobs_pending ON spike_jobs (run_at) WHERE status = 'pending';
