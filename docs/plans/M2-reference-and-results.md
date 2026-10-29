# M2 Reference Data and Results Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** real 2026 data flows in from Jolpica and OpenF1, becomes trusted per-session results that admins can correct, and a whole race weekend runs end to end, replayed from stored snapshots and then live in staging, with no admin action on a clean weekend.

**Architecture:**
- **Schema.** Data model Part 1 (reference data) and Part 2 (ingestion and results) become Drizzle schema plus SQL migrations. The rules that matter live in the database: `CHECK`s, exclusion constraints, partial unique indexes, the results-kind trigger and the blocking-review guard.
- **Providers.** Provider code lives behind adapters in `src/providers/`, and nothing else imports it (HLD §3.3 rule 2). Every call goes through one rate-limited HTTP client that stores raw snapshots.
- **Jobs.** Background work runs as rows in one `jobs` table, claimed with `SKIP LOCKED`.
- **Time.** Every entry point settles "now" once (HLD decision 20).
- **Replay.** The 2026 replay harness drives the same code from stored snapshots under a simulated clock.

**Tech Stack:**
- the M0 stack: Next.js 16, TypeScript strict, Drizzle 0.45, PGlite for tests, Vitest;
- Neon Functions and cron triggers for staging jobs;
- Jolpica (`api.jolpi.ca/ergast/f1`) and OpenF1 (`api.openf1.org/v1`), both read-only and free.

**Spec:**
- [docs/design/02-data-model.md](../design/02-data-model.md) Parts 0–2;
- [docs/design/01-high-level-design.md](../design/01-high-level-design.md) §3.3, §4, §8.2 and §12, with decision 20;
- [docs/design/04-implementation-plan.md](../design/04-implementation-plan.md) M2;
- the M1 result [docs/spikes/M1-scheduler.md](../spikes/M1-scheduler.md), which Task 10 waits for.

## Global Constraints
- **Layers never mix** (DM 0.5): reference, results and jobs code and tables are separate. Foreign keys point only down the stack, and results never hold points.
- **Only adapters know providers exist** (HLD §3.3 rule 2). Only `src/providers/**` may import `src/providers/**` or read `provider_ids`. An ESLint `no-restricted-imports` rule enforces this (Task 5).
- **The clock** (HLD decision 20): no `now()` in application SQL; it takes `$now`. Domain functions take a `Clock` or a `now: Date`, never `systemClock` directly. Only entry points call `resolveClock`.
- **IDs** are UUIDv7 from `newId()`. **Statuses** are `text` plus `CHECK`. **Timestamps** are `timestamptz`. Money isn't used in M2.
- **Never delete reference rows.** A missing or cancelled event becomes a status plus a review item (DM 1.3).
- **Writes from jobs are idempotent.** They use natural unique keys with `INSERT … ON CONFLICT`, and replace-style writes happen in one transaction (DM 0.7).
- **Provider rate limits** must stay under the published ones: Jolpica 4/s and 500/h, OpenF1 3/s and 30/min (HLD §4.1). The configured values go in `settings` as `provider_limits`: Jolpica `{ perSecond: 3, perHour: 400 }`, OpenF1 `{ perSecond: 2, perMinute: 25 }`.
- **Fixtures, not live calls, in tests.** Provider responses are recorded once into `tests/fixtures/{jolpica,openf1}/` and committed. No test reaches the network.
- **No new cloud resources** beyond `gridlocked-staging`. Task 12's CI deploy needs a Neon API key stored as a GitHub Actions secret, which waits for your approval.
- **Workflow:** one branch `m2/<issue>-<slug>` and one PR per task, closing its issue, with CI green before merge.

## Review Focus
1. **A provider response in a shape we've never seen** (a missing key, a new `positionText`, an extra field type). Expected: normalization fails for that session with a review item. No partial write, no guessed value, and the previous results stay. *Pinned in Task 7.*
2. **An admin's change overwritten by a sync**, such as a session time or `lock_at` set by an admin. Expected: the sync skips any field whose `*_source = 'admin'` and still updates the rest. *Pinned in Task 6.*
3. **A clock-mode mismatch**: a production deployment with a `simulated_clock` row, or `CLOCK_MODE=replay` without one. Expected: `resolveClock` throws a clear error and nothing runs. *Pinned in Task 1.*
4. **A backlog of provider calls in one minute**: the finalizer, the poller and a calendar sync firing together. Expected: the client queues and stays under 3/s and 400/h for Jolpica, and every call is still logged. *Pinned in Task 5.*
5. **A renumbered or relocated event matched to the wrong row.** Expected: a match that isn't unambiguous on season plus date plus name goes to the review queue as `uncertain_event_match` and isn't applied. *Pinned in Task 6.*

---

### Task 1: The shared clock (HLD decision 20)

**Files:**
- Create: `src/lib/resolve-clock.ts`, `src/lib/resolve-clock.test.ts`

**Interfaces:**
- Consumes: `Clock`, `systemClock` and `fixedClock` from `src/lib/clock.ts`; `createTestDb` from `tests/helpers/test-db.ts`.
- Produces:
  - `type ClockMode = 'system' | 'replay'`
  - `function clockModeFromEnv(env: Record<string, string | undefined>): ClockMode`. Unset means `'system'`, and any value other than `system` or `replay` throws.
  - `async function resolveClock(opts: { mode: ClockMode; db: { execute(q: SQL): Promise<{ rows: unknown[] }> }; scheduledAt?: Date }): Promise<Clock>`. It returns a `fixedClock`:
    - `system`: `scheduledAt` if given, otherwise `systemClock.now()`, with no database query except the guard below;
    - `replay`: one `select app_now()`.
  - `async function assertClockMode(db, mode: ClockMode): Promise<void>`. It throws `ClockModeError` when `system` finds a `simulated_clock` row, or when `replay` finds none. It's run once per deployment start and by `resolveClock` in replay mode; it's also cheap enough to run per job.

- [ ] **Step 1: Write the failing tests:**
  - `system` mode without `scheduledAt` returns a clock within 5 s of `systemClock.now()`. With `scheduledAt` it returns exactly that instant, and the database shows no queries for that call (check with a spy on `db.execute`).
  - `replay` mode, with `simulated_clock = {"at":"2026-11-29T16:00:00Z"}`, returns exactly that instant, and two `now()` calls on the result are equal.
  - Review Focus 3: `assertClockMode(db, 'system')` throws `ClockModeError` with the message `simulated_clock is set but CLOCK_MODE is system` when the row exists. `assertClockMode(db, 'replay')` throws `CLOCK_MODE is replay but simulated_clock is not set` when it doesn't.
  - `clockModeFromEnv({ CLOCK_MODE: 'fake' })` throws.
- [ ] **Step 2:** Run `pnpm test src/lib/resolve-clock.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement it. The ESLint direct-time rule stays as it is; this module calls `systemClock.now()`, not `Date.now()`.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: resolve the clock once per entry point (HLD decision 20)`.

### Task 2: Reference schema (DM Part 1)

**Files:**
- Create: `src/db/schema/reference.ts`, the generated migration and a custom `reference_constraints` migration (the extension, exclusion constraints, deferrable unique), `src/db/reference.test.ts`
- Modify: `src/db/schema/index.ts`, `src/db/test-db.test.ts` (the extension test: see Step 1)

**Interfaces:**
- Produces Drizzle tables, exactly as DM 1.1–1.11, with their names and columns:
  - `seasons`, `circuits`, `events`, `sessions`, `drivers`, `constructors`;
  - `constructorSeasons`, `seatAssignments`, `eventEntries`, `driverAvailability`, `providerIds`.
- Constraints:
  - `events (season_id, round)` unique, `DEFERRABLE INITIALLY IMMEDIATE`;
  - `sessions (event_id, kind, sequence)` unique;
  - `seat_assignments`: two exclusion constraints `EXCLUDE USING gist` for race seats. One is on `(driver_id WITH =, daterange(valid_from, valid_to, '[]') WITH &&)`, the other on `(season_id WITH =, car_number WITH =, daterange(…) WITH &&)`;
  - `provider_ids`: unique on both `(provider, entity_type, provider_key)` and `(provider, entity_type, entity_id)`;
  - `CHECK` lists from DM;
  - the indexes from DM 1.13.

- [ ] **Step 1: Write the failing tests** in `src/db/reference.test.ts`:
  - Renumbering two events' rounds in one transaction with `SET CONSTRAINTS ALL DEFERRED` succeeds, and the same swap without deferring fails.
  - A driver with overlapping race seats is rejected, while a reserve seat overlapping a race seat is allowed. A swap that closes one range on 2026-08-20 and opens the next on 2026-08-21 is allowed.
  - Two race seats with car number 30 in overlapping ranges are rejected.
  - An `events.status` of `'postponed'` is rejected by the `CHECK`.
  - Deleting a season that has events fails, because foreign keys are `RESTRICT`.
  - Change the M0 extension test: the migrations now create `btree_gist`, so the test asserts it's present in each fresh database, and `create extension if not exists ltree` succeeds there.
- [ ] **Step 2:** Run `pnpm test src/db`. Expected: FAIL.
- [ ] **Step 3:** Define the schema. Run `pnpm db:generate`. Write the custom migration with `pnpm db:generate --custom --name reference_constraints`, starting with `CREATE EXTENSION IF NOT EXISTS btree_gist;`.
- [ ] **Step 4:** Run `pnpm test src/db && pnpm db:drift`. Expected: PASS, and no drift.
- [ ] **Step 5:** Commit: `feat: add the reference data schema (DM Part 1)`.

### Task 3: Ingestion and results schema (DM Part 2)

**Files:**
- Create: `src/db/schema/results.ts`, `src/db/schema/jobs.ts`, the generated migration plus a custom `results_rules` migration (`pnpm db:generate --custom --name results_rules`), `src/db/results.test.ts`
- Modify: `src/db/schema/index.ts`

**Interfaces:**
- Produces the tables from DM 2.1–2.10:
  - `providerRequests`, `rawSnapshots`, `sessionResultState`, `results`, `resultChanges`, `resultOverrides`, `sessionParticipants`, `reviewItems`, `jobs`;
  - plus the SQL view `effective_results`.
- Rules in SQL:
  - a `BEFORE INSERT` trigger copies `sessions.kind` into `results.session_kind`;
  - `CHECK`s keep `grid` and `pit_lane_start` on sprint and race rows only, and `q1_ms`–`q3_ms` on qualifying and sprint qualifying rows only;
  - a partial unique index on `result_overrides (session_id, driver_id) WHERE revoked_at IS NULL`;
  - a partial unique index on `review_items (dedupe_key) WHERE status = 'open'`;
  - unique `jobs (kind, dedupe_key)`;
  - a `BEFORE UPDATE` trigger on `session_result_state` raises `open blocking review item` when `status` moves to `provisional` or `final` while an open blocking item exists for that session (DM 2.9);
  - `effective_results` follows DM 2.7: patches applied field by field, inserts added, suppressions removed, plus an `overridden boolean` and `override_reason`.

- [ ] **Step 1: Write the failing tests:**
  - A qualifying row with `grid = 5` is rejected, and so is a race row with `q1_ms`.
  - `effective_results`:
    - a `patch` of `{position: 8}` with a reason shows position 8, `overridden = true` and that reason;
    - revoking the patch shows the provider value again;
    - a `suppress` hides the row;
    - an `insert` adds a row the provider lacks.
  - A second active override for the same driver and session is rejected.
  - The blocking guard: with an open blocking item, `UPDATE session_result_state SET status = 'provisional'` raises the error. With the item resolved, it succeeds. A `warning` item doesn't block.
  - A duplicate `jobs (kind, dedupe_key)` is rejected, and so is a duplicate open review `dedupe_key`. A resolved item doesn't stop a new open one with the same key.
- [ ] **Step 2:** Run `pnpm test src/db`. Expected: FAIL.
- [ ] **Step 3:** Define the schema and write the custom migration.
- [ ] **Step 4:** Run `pnpm test src/db && pnpm db:drift`. Expected: PASS, and no drift.
- [ ] **Step 5:** Commit: `feat: add the ingestion and results schema (DM Part 2)`.

### Task 4: The job runtime

**Files:**
- Create: `src/jobs/queue.ts`, `src/jobs/queue.test.ts`, `src/jobs/runner.ts`, `src/jobs/runner.test.ts`

**Interfaces:**
- Consumes: the `jobs` table from Task 3, and a `Clock` (Task 1).
- Produces:
  - `async function enqueue(db, job: { kind: JobKind; dedupeKey: string; runAt: Date; payload: unknown; maxAttempts?: number }): Promise<{ id: string; created: boolean }>`. It inserts the job, or updates `run_at` and `payload` if a **pending** job with the same key exists (DM 2.10, "a time change updates `run_at`"). A running or finished job isn't touched.
  - `async function claimNext(db, now: Date, leaseMs: number): Promise<Job | null>`. It takes one pending job with `run_at <= $now`, or a `running` job whose lease has passed, using `FOR UPDATE SKIP LOCKED`. It sets `status = 'running'`, `attempts + 1`, `locked_until = now + lease` and `started_at`.
  - `async function complete(db, id, now)` and `async function fail(db, id, now, error: string)`. `fail` sets the job back to `pending` with `run_at = now + backoff(attempts)`, where backoff is 1, 5 and 15 minutes. At `max_attempts` it becomes `dead`.
  - `type JobHandler = (job: Job, ctx: { db; clock: Clock }) => Promise<void>`
  - `async function runDue(db, clock: Clock, handlers: Record<JobKind, JobHandler>, opts: { maxJobs: number; leaseMs: number }): Promise<{ ran: number; failed: number }>`

- [ ] **Step 1: Write the failing tests:**
  - `enqueue` twice with the same key gives one row, and the second call's `runAt` wins while the job is pending. Once the job is `succeeded`, a third `enqueue` doesn't change it.
  - `claimNext` returns nothing before `run_at`, and the job at `run_at` exactly.
  - Claiming twice in a row gives the job once, then `null`.
  - A `running` job whose lease has passed is claimed again with `attempts = 2`.
  - `fail` three times with `maxAttempts = 3` ends `dead`.
  - `runDue` with a handler that throws on its first call records `failed: 1`, then `ran: 1` on the run after the backoff.
- [ ] **Step 2:** Run `pnpm test src/jobs`. Expected: FAIL.
- [ ] **Step 3:** Implement it. `$now` is always a parameter.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: add the job queue and runner`.

PGlite is a single connection, so two truly concurrent claims are checked on staging in Task 12, the same way as the M1 spike.

### Task 5: The provider HTTP client and snapshot store

**Files:**
- Create: `src/providers/http/client.ts`, `src/providers/http/client.test.ts`, `src/providers/http/rate-limiter.ts`, `src/providers/http/rate-limiter.test.ts`, `src/providers/snapshots.ts`, `src/providers/snapshots.test.ts`
- Modify: `eslint.config.mjs` (the provider import boundary)

**Interfaces:**
- Produces:
  - `function createRateLimiter(limits: { perSecond: number; perMinute?: number; perHour?: number }, clock: Clock, sleep: (ms: number) => Promise<void>): { acquire(): Promise<void> }`, a sliding window over the recorded call times.
  - `function createProviderClient(opts: { provider: 'jolpica' | 'openf1'; baseUrl: string; db; clock: Clock; fetch: typeof fetch; limiter }): { get(endpoint: string, params?: Record<string, string>, ctx?: { jobId?: string; seasonId?; eventId?; sessionId? }): Promise<{ snapshotId: string; body: unknown; changed: boolean }> }`. Each call:
    - logs to `provider_requests` with an outcome of `new_snapshot`, `unchanged`, `error` or `rate_limited`;
    - stores a snapshot through `storeSnapshot`;
    - on `429`, waits `Retry-After` (or 30 s) up to 3 times.
  - `function canonicalJson(value: unknown): string` (keys sorted at every level), and `async function storeSnapshot(db, s: { provider; endpoint; params; body; now: Date; seasonId?; eventId?; sessionId? }): Promise<{ id: string; changed: boolean }>`. That uses `INSERT … ON CONFLICT (params_hash, content_hash) DO UPDATE SET last_seen_at`.
- ESLint: the `no-restricted-imports` pattern `@/providers/*` is banned in files outside `src/providers/**`, with the message `Only adapters know providers exist (HLD §3.3 rule 2).` A fixture file proves it, like M0's time-read rule test.

- [ ] **Step 1: Write the failing tests:**
  - `canonicalJson({b:1,a:{d:2,c:3}}) === '{"a":{"c":3,"d":2},"b":1}'`.
  - Storing the same body twice gives one snapshot, `changed: false` and a moved `last_seen_at`. A body that differs only in key order also gives `changed: false`.
  - The rate limiter, with a simulated clock and a fake `sleep` that advances it:
    - 10 `acquire()` calls at limit 3/s take at least 3 simulated seconds;
    - Review Focus 4: 450 calls at `perHour: 400` leave 50 waiting until the hour rolls.
  - The client:
    - a `429` with `Retry-After: 2` then a `200` gives 2 `provider_requests` rows (`rate_limited`, then `new_snapshot`) and one snapshot;
    - a network error gives an `error` row with `status_code` null, and the client rethrows.
  - The lint test: the fixture `tests/lint/fixtures/imports-provider.ts` importing `@/providers/http/client` gives 1 error.
- [ ] **Step 2:** Run `pnpm test src/providers tests/lint`. Expected: FAIL.
- [ ] **Step 3:** Implement it. `params_hash` is the SHA-256 of `canonicalJson({provider, endpoint, params})`.
- [ ] **Step 4:** Run the tests and `pnpm lint`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: add the rate-limited provider client and snapshot store`.

### Task 6: Jolpica fixtures and the calendar sync

**Files:**
- Create:
  - `scripts/record-fixtures.ts`, a one-off script, run by hand, that respects the limits;
  - `tests/fixtures/jolpica/2026/` (the calendar, drivers, constructors, and the results listed below);
  - `src/providers/jolpica/calendar.ts`, `src/providers/jolpica/calendar.test.ts`;
  - `src/reference/sync-calendar.ts`, `src/reference/sync-calendar.test.ts`.

**Interfaces:**
- Fixtures to record, once, with about 40 calls, well under the limits:
  - `2026.json` (the calendar);
  - `2026/drivers.json`, `2026/constructors.json`;
  - for round 18, `qualifying` and `results`;
  - one 2026 sprint weekend's `sprint` and `results`;
  - China 2025 (round 2) `results`, where Hamilton and Leclerc were disqualified;
  - the rounds 12–14 race results (the Lawson, Tsunoda and Hadjar swap).

  Each file is saved as the raw response body.
- Produces:
  - `function parseJolpicaCalendar(body: unknown): CalendarEvent[]`, our own shape with no provider keys outside the adapter;
  - `async function syncCalendar(db, clock: Clock, season: number, source: { events: CalendarEvent[]; snapshotId: string }): Promise<SyncReport>`. It:
    - upserts circuits, events and sessions;
    - writes `provider_ids`;
    - re-matches events by season plus date (±3 days) plus normalized name, and updates `round` and the provider key;
    - never deletes;
    - opens `event_missing_from_provider` and `uncertain_event_match` review items;
    - skips fields whose `*_source = 'admin'`;
    - derives `scheduled_end` from the `session_durations` setting;
    - sets `lock_session_id` and `lock_at`: Qualifying, or Sprint Qualifying on sprint weekends.

- [ ] **Step 1:** Add `tsx` as a devDependency. Run `pnpm tsx scripts/record-fixtures.ts`, then commit the fixtures. The script uses the Task 5 client against the live APIs, then writes the bodies to files.
- [ ] **Step 2: Write the failing tests:**
  - Syncing the 2026 calendar creates 23 events, and sessions with per-kind `scheduled_end`. Sprint weekends lock on Sprint Qualifying.
  - Syncing again changes nothing (`SyncReport.changed = 0`).
  - A synthetic copy with Miami moved from round 4 to round 6 updates only `round` and the provider key.
  - A copy with one event removed keeps the row and opens `event_missing_from_provider`.
  - Review Focus 5: a copy where an event changes both name and circuit by more than the match rule allows opens `uncertain_event_match` and changes nothing.
  - Review Focus 2: with `sessions.time_source = 'admin'` on Qualifying and `lock_at_source = 'admin'`, a synced time change leaves both alone and still updates the other sessions.
- [ ] **Step 3:** Run `pnpm test src/reference src/providers/jolpica`. Expected: FAIL.
- [ ] **Step 4:** Implement it.
- [ ] **Step 5:** Run the tests. Expected: PASS.
- [ ] **Step 6:** Commit: `feat: sync the Jolpica calendar into reference data`.

### Task 7: Results normalizer and change log

**Files:**
- Create: `src/providers/jolpica/results.ts`, `src/providers/jolpica/results.test.ts`, `src/results/normalize.ts`, `src/results/normalize.test.ts`

**Interfaces:**
- Produces:
  - `function parseJolpicaResults(kind: SessionKind, body: unknown): { ok: true; rows: ResultRow[] } | { ok: false; problem: string }`. It maps classifications per the DM 2.4 table, treats `""` and a missing Q time alike as null, maps `grid = 0` to `pit_lane_start` with `grid` null, and fails on an unknown `positionText`.
  - `async function normalizeSession(db, now: Date, sessionId: string, snapshotId: string, parsed): Promise<{ changed: number }>`. In one transaction it replaces the session's `results` rows, writes `result_changes` against the previous rows, and sets `current_snapshot_id`. On `ok: false` it writes nothing except a `blocking` review item of kind `unknown_classification` or `validation_failed`, with `dedupe_key = normalize:<session_id>:<snapshot_id>`.

- [ ] **Step 1: Write the failing tests:**
  - Round 18 qualifying: 22 rows, and the Q3 driver with no Q3 time has `q3_ms` null and position 10.
  - Race fixtures:
    - `Retired` with a numeric `positionText` is `classified`;
    - `W` is `did_not_start`;
    - a DSQ is `disqualified`.
  - A synthetic `grid: "0"` row has `pit_lane_start = true` and `grid` null.
  - Normalizing twice with the same snapshot changes nothing. A second snapshot with two positions swapped writes 2 `result_changes` rows (`position`, `P6 → P8` style).
  - Review Focus 1:
    - a body with `positionText: "Z"` writes no rows, keeps the previous results and opens one blocking review item;
    - running it again doesn't open a second one;
    - a body missing `Results` entirely does the same.
- [ ] **Step 2:** Run `pnpm test src/results src/providers/jolpica`. Expected: FAIL.
- [ ] **Step 3:** Implement it.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: normalize Jolpica results with a change log`.

### Task 8: Overrides, validator and session status

**Files:**
- Create: `src/results/overrides.ts`, `src/results/overrides.test.ts`, `src/results/validate.ts`, `src/results/validate.test.ts`, `src/results/status.ts`, `src/results/status.test.ts`

**Interfaces:**
- Produces:
  - `async function addOverride(db, now, o: { sessionId; driverId; kind: 'patch' | 'insert' | 'suppress'; fields?: Partial<ResultFields>; reason: string; createdBy: string }): Promise<string>`. It revokes any active override first. `fields` is validated by a Zod schema generated from the `results` columns.
  - `async function revokeOverride(db, now, id, by): Promise<void>`.
  - `async function validateSession(db, sessionId): Promise<Problem[]>`, the HLD §4.4 checks:
    - every expected entry is accounted for;
    - no unknown driver or constructor;
    - contiguous positions;
    - plausible grids;
    - at most one fastest-lap rank 1;
    - cars per constructor at most `validator_thresholds.carsPerConstructor` (2), counted per session;
    - every driver–constructor pair is in `event_entries`, or it opens `team_change` or `unknown_driver` (HLD §8.2).

    Fewer rows than entries counts as **not yet complete** (`Problem.kind = 'incomplete'`), not a failure.
  - `async function advanceStatus(db, now, sessionId): Promise<SessionResultStatus>`. It runs validation, opens or refreshes review items, and moves `awaiting → provisional`, or to `under_review` with an open blocking item, in the same transaction. `incomplete` keeps it `awaiting`.
  - `provider_after_manual`: when `session_result_state.source = 'manual'` and a provider snapshot normalizes, a review item opens and the manual inserts stay (DM 2.6).

- [ ] **Step 1: Write the failing tests:**
  - A clean round 18 race moves to `provisional`.
  - Removing one row makes it `incomplete` and keeps it `awaiting`.
  - A row with an unknown constructor pairing opens `team_change` and moves to `under_review`. Resolving the item and calling `advanceStatus` again moves it to `provisional`.
  - A `patch` changes what `effective_results` shows and what `validateSession` reads.
  - Provider data after manual entry opens `provider_after_manual` and keeps the inserts.
  - The rounds 12–14 fixtures, with the seats from DM 1.8, validate cleanly.
- [ ] **Step 2:** Run `pnpm test src/results`. Expected: FAIL.
- [ ] **Step 3:** Implement it.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: add overrides, the results validator and session status`.

### Task 9: OpenF1 practice participants and the roster check

**Files:**
- Create: `tests/fixtures/openf1/` (recorded by the Task 6 script, extended), `src/providers/openf1/participants.ts`, `src/providers/openf1/participants.test.ts`, `src/reference/roster-check.ts`, `src/reference/roster-check.test.ts`

**Interfaces:**
- Produces:
  - `function parseOpenF1Drivers(body: unknown): { driverNumber: number; teamName: string; acronym: string }[]`
  - `async function storeParticipants(db, sessionId, snapshotId, rows): Promise<void>`. It maps to our driver and constructor IDs through `provider_ids`, and opens `unknown_driver` for anything unmapped.
  - `async function rosterCheck(db, now, eventId): Promise<Problem[]>`. It compares FP2 and FP3 participants with `event_entries`, and opens `team_change` or `missing_driver` warnings (HLD §8.2). FP1 counts as a weak signal and opens nothing.

- [ ] **Step 1: Write the failing tests:**
  - The round 12 FP2 fixture maps every driver.
  - A synthetic substitute in FP3 opens one `team_change` warning, and a rerun doesn't duplicate it.
  - An FP1-only young driver opens nothing.
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement it.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: record practice participants and check the roster`.

### Task 10: Pipeline jobs and the scheduler (after the M1 verdict)

**Files:**
- Create: `src/jobs/kinds.ts`, `src/jobs/plan-event.ts`, `src/jobs/plan-event.test.ts`, `src/jobs/poll.ts`, `src/jobs/poll.test.ts`, `src/jobs/finalize.ts`, `src/jobs/finalize.test.ts`, `src/jobs/due-times.ts`, `src/jobs/due-times.test.ts`, `src/jobs/tick.ts`

**Interfaces:**
- Consumes: Tasks 4–9, and the M1 result: where the due-times file lives, its shape, and the safety-tick cadence.
- Produces:
  - `type JobKind = 'sync_calendar' | 'poll_session' | 'normalize' | 'validate' | 'finalize_check' | 'roster_check'`. Scoring and threads are added in M4 and M7.
  - `async function planEventJobs(db, eventId): Promise<void>`, with dedupe keys `poll:<session_id>:start`, `finalize:<event_id>:<+2h|+6h|+24h|+48h>` and `roster:<event_id>:<fp2|fp3>`. A session time change moves `run_at` through `enqueue`.
  - Poll handler: fetch, normalize, advance the status. While `awaiting`, re-enqueue `poll:<session_id>:<attempt>` at +5, +15 and then +60 minutes. At 24 hours past `scheduled_end`, set `gave_up_at` and open a `blocking` review item.
  - Finalize handler: re-fetch; on a changed snapshot, normalize and advance. After the +48 h check with no blocking items, `final` and `events.status = completed`.
  - `async function publishDueTimes(db, store, now): Promise<DueFile>` and `async function tick(db, store, scheduledAt: Date, mode: ClockMode)`, the M1 design adapted to the real `jobs` table. **From the M1 result:** the file is `scheduler/due-times.json` in Neon Object Storage; the safety tick runs every 6 hours (`7 */6 * * *`); the tick republishes after every wake, republishes a missing or malformed file at once, and code that enqueues outside a tick calls `republishIfEarlier`. **Split (ruling R19):** Task 10a is the kinds, planning, poll, finalize and roster jobs (PR #58); Task 10b is the due-times file and the tick.

- [ ] **Step 1: Write the failing tests** with a simulated clock and fixtures:
  - Planning the round 18 weekend creates the expected job keys with the right `run_at`s. Moving qualifying 30 minutes later moves its poll job and leaves the others alone.
  - A poll that finds `awaiting` (an empty fixture) re-enqueues at +5, then +15, then +60 minutes. At 24 hours it gives up with a blocking item.
  - A finalize check with a changed snapshot writes `result_changes`. After +48 h the event is `completed`.
  - `tick` with a due-times file whose `next_due_at` is in the future makes no database call (check with a spy).
- [ ] **Step 2:** Run `pnpm test src/jobs`. Expected: FAIL.
- [ ] **Step 3:** Implement it.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: plan, poll and finalize race weekends`.

### Task 11: The 2026 import and the replay harness

**Files:**
- Create: `src/replay/harness.ts`, `src/replay/harness.test.ts`, `scripts/import-2026.ts`

**Interfaces:**
- Produces:
  - `async function replayWeekend(db, opts: { season: 2026; round: number; fixturesDir: string; inject?: Injection[] }): Promise<ReplayReport>`. It:
    - sets `simulated_clock`;
    - uses `CLOCK_MODE=replay`;
    - steps time minute by minute through the weekend window, calling `tick` and `runDue` at each step;
    - serves provider calls from the fixtures in `first_fetched_at` order through a fake `fetch`.
  - `type Injection = { at: string; kind: 'penalty'; driver: string; seconds: number } | { at: string; kind: 'outage'; until: string }`
  - `scripts/import-2026.ts` imports every recorded 2026 round from fixtures into a target database.

- [ ] **Step 1: Write the failing tests:**
  - Replaying round 18 ends with every scored session `final` and the event `completed`, with no review items opened.
  - Replaying with an injected +5 s penalty after the race gives `result_changes` rows and a different effective order at the next finalize check.
  - With an injected outage from race end to +3 h, polling backs off and recovers after the outage, with no give-up.
  - The import of all recorded rounds is idempotent: run twice, it gives the same row counts.
- [ ] **Step 2:** Run `pnpm test src/replay`. Expected: FAIL.
- [ ] **Step 3:** Implement it.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: add the 2026 import and replay harness`.

### Task 12: Staging and a live weekend (controller)

**Files:**
- Create: `.github/workflows/deploy-staging.yml` (manual dispatch), `src/jobs/functions/tick.ts` (the Neon Function entry)
- Modify: `docs/design/04-implementation-plan.md` (the M2 exit evidence)

**Approval needed first:**
- a Neon API key for `gridlocked-staging`, stored as the GitHub Actions secret `NEON_API_KEY_STAGING`;
- a `DATABASE_URL_STAGING` secret, for migrations.

Real drivers make the bundle too big for the MCP deploy route that M1 used, so CI deploys with the `neon` CLI.

- [ ] **Step 1:** Run the migrations against `gridlocked-staging`'s `main` branch, import 2026, and deploy `tick` with its triggers.
- [ ] **Step 2:** On staging, run two concurrent `claimNext` calls against one due job. Expected: one claim (Task 4's note).
- [ ] **Step 3: The live weekend.** Qatar (29 Nov) or Abu Dhabi (6 Dec): the calendar sync, polling, normalization, validation and finalization run with no admin action. Record the timeline, any review items, and Neon usage against the M1 numbers.
- [ ] **Step 4:** Write the exit evidence into the roadmap's M2 section and close the M2 epic.

## Done when
- Tasks 1–11 are merged with green CI, and `pnpm test` covers every DM Part 1 and Part 2 scenario-table row that M2 owns.
- The whole recorded 2026 season imports from fixtures, and a replayed weekend reaches `final` with no admin action.
- A live 2026 weekend is ingested end to end in staging (Task 12).
