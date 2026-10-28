# M1 Spike: Scheduler Tick Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** find out, with measured numbers, whether a once-a-minute scheduler tick can run on Neon's free plan without keeping the database awake, and record where the due-times file lives.

**Architecture:**
- A Neon Function `tick` is triggered every minute by a Neon cron trigger.
- It reads a small due-times file from Neon Object Storage. It connects to Postgres only when a due time has passed, claims due jobs from a job table with uniqueness keys, runs them (in the spike, a log line and a row), then rewrites the file.
- An hourly safety trigger checks the job table directly and republishes the file.
- A measurement script on this Mac samples the project's usage while synthetic jobs run, so the result can be extrapolated to a month and a race weekend.

**Tech Stack:**
- Neon Functions (Node 24), Neon cron triggers, Neon Object Storage (S3 API via `@aws-sdk/client-s3`) and Neon Postgres 17;
- `@neondatabase/serverless`, Hono;
- Vitest for the tick's decision logic.

**Spec:** [docs/design/04-implementation-plan.md](../design/04-implementation-plan.md) (M1), with HLD §4.5 (scheduling without waking the database), §11.2 and §11.4 (free-tier limits). DM 2.x's job table is the eventual home of the job rows; the spike uses a cut-down copy.

## Global Constraints
- **Throwaway code.** All spike code lives in `spikes/m1-scheduler/` on branch `spike/m1-scheduler`, which is **never merged**. Only `docs/spikes/M1-scheduler.md` (the result) and any design-doc changes merge to `main`, through their own PR.
- **One cloud resource, approved 2026-10-28:** the Neon project `gridlocked-staging`, Free plan, region `aws-us-east-1`, Postgres 17. Nothing else is created: no Vercel, no paid plan, no other Neon project.
- **Spike on a child branch.** All spike resources (functions, triggers, bucket, tables) go on a child branch `m1-spike` of the staging project. The branch is deleted at the end, leaving the staging project empty for M2.
- **Autoscaling capped at 0.25 CU** (min and max) on the staging project (HLD §11.4 change 6).
- **The tick must not wake Postgres when nothing is due** (HLD §4.5). This is the property being measured.
- **Trigger calls only.** The `tick` and `safety` routes reject any request without the `X-Neon-Trigger-Invocation-Id` header with `403`, so a stranger hitting the public URL can't wake the database.
- **"Now" is the trigger's `data.scheduled_at`**, never `Date.now()`. That keeps the decision logic pure and testable, and matches HLD §3.3 rule 6.
- **Due-times file:** bucket `scheduler`, key `due-times.json`, private. Shape: `{ "version": 1, "generated_at": "<ISO>", "next_due_at": "<ISO>" | null }`.
- **Job table (spike copy):** `spike_jobs(id uuid pk, kind text not null, dedupe_key text not null unique, run_at timestamptz not null, status text not null default 'pending', claimed_at timestamptz, done_at timestamptz)`.
- **No secrets in git.** Credentials come from Neon's injected variables (`DATABASE_URL`, `AWS_*`) inside functions, and from a git-ignored `spikes/m1-scheduler/.env` on this Mac.

## Review Focus
1. **A missing or malformed due-times file.** Expected: the tick logs it and does not connect to Postgres. The hourly safety tick republishes the file. A bad file must never become "wake every minute". *Pinned in Task 2.*
2. **A due time in the past with no pending job** (for example, the job ran but the file rewrite failed). Expected: the tick wakes Postgres once, finds nothing, and rewrites the file with the next real due time, so it doesn't wake again every minute. *Pinned in Task 2.*
3. **Two ticks for the same minute** (a redelivered or overlapping trigger). Expected: each job runs exactly once. *Pinned in Task 3.*
4. **A due time exactly equal to `scheduled_at`.** Expected: it counts as due (`run_at <= now`). *Pinned in Task 2.*
5. **A request to the public URL without the trigger header.** Expected: `403`, no Postgres connection and no Object Storage read. *Pinned in Task 3.*

---

### Task 1: Staging project and spike branch (controller, cloud)

**Files:**
- Create: `docs/spikes/M1-scheduler.md` (skeleton: question, setup, measurements table, result, decision), on branch `m1/spike-result`

**Interfaces:**
- Produces: project id, branch id of `m1-spike`, and bucket `scheduler`, recorded in the spike doc's Setup section. No credentials are recorded.

- [ ] **Step 1:** Create the project with the Neon MCP `create_project`: name `gridlocked-staging`, `region_id: aws-us-east-1`, `pg_version: 17`, `default_endpoint_settings.autoscaling_limit_min_cu: 0.25` and `autoscaling_limit_max_cu: 0.25`. Expected: the project is listed with those settings.
- [ ] **Step 2:** Create the child branch `m1-spike` with a read-write compute, and the private bucket `scheduler` on it.
- [ ] **Step 3:** Record a usage baseline: the project's `active_time`, `cpu_used_sec`, `compute_last_active_at` and data transfer, plus the date and time. Find out from the docs and the API where Function capacity-hours and invocations can be read on the Free plan. The plans page says they don't appear in the Console summary. Record the answer, because it decides how Task 4 measures.
- [ ] **Step 4:** Commit the spike doc skeleton: `docs: start the M1 scheduler spike write-up`.

### Task 2: Tick decision logic (local, TDD)

**Files:**
- Create: `spikes/m1-scheduler/package.json`, `spikes/m1-scheduler/src/decide.ts`, `spikes/m1-scheduler/src/decide.test.ts`, `spikes/m1-scheduler/src/due-file.ts`, `spikes/m1-scheduler/src/due-file.test.ts`

**Interfaces:**
- Produces:
  - `type DueFile = { version: 1; generated_at: string; next_due_at: string | null }`
  - `function parseDueFile(text: string | null): { ok: true; file: DueFile } | { ok: false; reason: 'missing' | 'malformed' }`
  - `function decideTick(due: ReturnType<typeof parseDueFile>, now: Date): { action: 'sleep' } | { action: 'wake' } | { action: 'skip'; reason: 'missing' | 'malformed' }`
  - `function nextDueFile(pendingRunAts: Date[], now: Date): DueFile`, where `next_due_at` is the earliest pending `run_at`, or `null` when there's none.

- [ ] **Step 1: Write the failing tests:**
  - `decideTick` returns `sleep` when `next_due_at` is after `now`, and when `next_due_at` is `null`.
  - Review Focus 4: it returns `wake` when `next_due_at` equals `now`, and when it's before `now`.
  - Review Focus 1: `parseDueFile(null)` gives `missing`. Each of `'not json'`, `'{}'`, `'{"version":2,"generated_at":"x","next_due_at":null}'` and a `next_due_at` that isn't an ISO instant with an offset gives `malformed`. `decideTick` on either returns `skip`, never `wake`.
  - Review Focus 2: `nextDueFile([], now).next_due_at === null`. `nextDueFile([t3, t1, t2], now).next_due_at === t1.toISOString()`. `generated_at === now.toISOString()`.
- [ ] **Step 2:** Run `pnpm vitest run` in `spikes/m1-scheduler`. Expected: FAIL (modules missing).
- [ ] **Step 3:** Implement `decide.ts` and `due-file.ts`. They're pure and take `now` as a parameter.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit on `spike/m1-scheduler`: `spike: tick decision logic and due-times file parsing`.

### Task 3: The `tick` and `safety` functions, deployed

**Files:**
- Create: `spikes/m1-scheduler/src/tick.ts` (the Hono app with routes `POST /` for the tick and `POST /safety` for the safety check), `spikes/m1-scheduler/src/jobs.ts`, `spikes/m1-scheduler/sql/001_spike_jobs.sql`, `spikes/m1-scheduler/scripts/double-tick.ts`, `spikes/m1-scheduler/.gitignore` (`.env`)

**Interfaces:**
- Consumes: `parseDueFile`, `decideTick` and `nextDueFile` from Task 2.
- Produces:
  - `async function claimDueJobs(sql, now: Date): Promise<{ id: string; kind: string }[]>`. It runs one `UPDATE spike_jobs SET status='running', claimed_at=$now WHERE status='pending' AND run_at <= $now RETURNING id, kind`. The `UPDATE`'s row locks make claiming exactly-once.
  - `async function finishJobs(sql, ids: string[], now: Date): Promise<void>`
  - `async function publishDueFile(s3, sql, now: Date): Promise<DueFile>`. It reads pending `run_at`s, builds the file with `nextDueFile` and writes it.
  - The tick handler's flow:
    1. No trigger header → `403`.
    2. Read the file → `decideTick` with `now = data.scheduled_at`.
    3. `sleep` or `skip` → return with no Postgres connection, and log `tick <scheduled_at> <action>`.
    4. `wake` → claim, finish, then always `publishDueFile`.
  - The `safety` handler: trigger header required, then always `publishDueFile`.

- [ ] **Step 1:** Read Neon's deploy docs (`docs/compute/functions/deploy`) for how to package a function for the MCP `deploy_function` zip, or for the `neon functions deploy` CLI. Pick one and note it in the spike doc.
- [ ] **Step 2:** Apply `sql/001_spike_jobs.sql` to `m1-spike`. Deploy slug `tick`. Create the triggers `tick-every-minute` (`* * * * *`, path `/`) and `safety-hourly` (`7 * * * *`, path `/safety`).
- [ ] **Step 3:** Review Focus 5: `curl -X POST` the function URL with no headers. Expected: `403`, and the logs show no Postgres or S3 activity for that request.
- [ ] **Step 4:** Review Focus 3: run `scripts/double-tick.ts`. It seeds one job due now, then sends two requests concurrently with the same `scheduled_at`, carrying the trigger header (Neon strips client-set `X-Neon-*` headers on the public URL, so if that blocks it, call `claimDueJobs` twice concurrently against the branch from the Mac instead). Expected: exactly one `done` row, and one `running → done` transition in the logs.
- [ ] **Step 5:** Review Focus 1 on the live system: delete `due-times.json`. Expected: ticks log `skip missing` with no Postgres connection, and the next safety run republishes the file.
- [ ] **Step 6:** Commit on `spike/m1-scheduler`: `spike: tick and safety functions with job claiming`.

### Task 4: Measure (24–48 hours)

**Files:**
- Create: `spikes/m1-scheduler/scripts/seed-jobs.ts`, `spikes/m1-scheduler/scripts/sample-usage.ts`, `spikes/m1-scheduler/data/usage.csv`

**Interfaces:**
- Consumes: the deployed functions and triggers from Task 3. Reads the usage source chosen in Task 1 Step 3.

- [ ] **Step 1:** Seed a schedule that mimics the calendar:
  - **Quiet period:** 3 jobs spread over 12 hours.
  - **Race-weekend window:** a 6-hour block with a job every 10 minutes, plus a burst of 20 jobs due at the same minute (the finalizer and notifications after a session).
- [ ] **Step 2:** Run `scripts/sample-usage.ts` every 10 minutes for the whole window, appending to `data/usage.csv`. Columns: `sampled_at, active_time_s, cpu_used_s, compute_last_active_at, transfer_bytes`, plus function metrics if Task 1 found a source. Also count tick log lines by action (`sleep`, `wake`, `skip`).
- [ ] **Step 3:** Expected, and the pass condition: during the quiet period, `compute_last_active_at` advances only around the 3 due times and the hourly safety runs. Database active time grows by about (number of wakes × ~5 min), not by the length of the period.
- [ ] **Step 4:** Find out whether the hourly safety tick costs more than the minute tick saves. Each safety run wakes Postgres, so 24 a day × ~5 minutes is about 2 awake hours a day, or 60 a month: 15 CU-hours at 0.25 CU. Measure it, and record whether `publishDueFile` in the safety tick should become every 6 hours, or skip Postgres when the file is fresh.

### Task 5: Write-up, decisions and cleanup (controller)

**Files:**
- Modify: `docs/spikes/M1-scheduler.md`, plus `docs/design/01-high-level-design.md` §4.5 and §11.4, and `docs/design/04-implementation-plan.md` M2, if the result changes the design.

- [ ] **Step 1:** Fill in the write-up.
  - Measured numbers: database CU-hours, function capacity-hours and invocations, transfer.
  - Extrapolations: a quiet month, and a month with 2 race weekends, against the free limits.
  - The answer to "where does the due-times file live" (Neon Object Storage, or why not).
  - The safety-tick cadence, and anything that surprised us.
  - A clear verdict: **fits as designed**, **fits with changes** (listed), or **doesn't fit** (and the fallback).
- [ ] **Step 2:** Update HLD §4.5 and §11.4 and the M2 scope with the decisions.
- [ ] **Step 3:** Delete the cloud resources on `m1-spike`, which are its triggers, functions and bucket, then delete the branch itself. Confirm that the staging project's root branch has no triggers, functions or buckets. Push `spike/m1-scheduler` for the record, and close it unmerged.
- [ ] **Step 4:** Open the PR from `m1/spike-result` with "Closes" for the M1 task issues, merge it once CI is green, and close the M1 epic.

## Done when
- `docs/spikes/M1-scheduler.md` on `main` gives measured numbers and a verdict.
- The HLD and roadmap reflect the decision.
- The staging project exists, and is empty, for M2.
- The spike branch is closed unmerged.
