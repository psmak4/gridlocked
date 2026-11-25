# M9 Hardening and Closed Beta Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** prove the app on real people with replayed 2026 weekends (roadmap M9, epic psmak4/gridlocked#10).

**Exit:**
- the carry-overs from M5, M6, M7 and M8 are done or ruled on;
- a race-end spike and chat-mode refreshes are load-tested on staging, and a replayed race weekend and a quiet week are measured against the free limits (HLD §12.6 and §12.7);
- every page passes an automated accessibility sweep at phone and desktop size, and the security review's findings are fixed or ruled on;
- errors reach Sentry, and a usage meter at 70% alerts an admin by push;
- a backup is restored into a scratch branch and checked, following a written runbook;
- the closed beta has run its replayed weekends, and the bugs it found are fixed or carried to M10 by name;
- your lawyer's Terms, Privacy Policy and Community rules are published, or carried to M10 with a date;
- production exists (with your approval), empty, with its backups and alerts on, ready for M10's launch.

**Architecture:**
- **The beta runs on staging, switched to replay mode after the 2026 season ends.** Staging has no live racing to follow from about 9 December (Abu Dhabi's last re-check) until the 2027 opener. The beta needs a replayed season and a database that has never polled live data. So staging's `main` branch is kept as it is, and a new branch on the same Neon project, `beta`, is created from an empty state and imported fresh. Staging's Vercel project points at that branch for the beta (decision 1).
- **A replay clock that runs by itself.** Today `simulated_clock` only moves in tests (`src/replay/clock-loop.ts`). The beta adds a `replay_offset` setting: the tick sets the clock to real time minus the offset before it runs, so a 2026 weekend plays out in real time on a beta weekend. Staff can pause it, or jump it to the next round's Friday. The tick runs as it does now. Only the instant it's given changes.
- **Providers stay real.** In replay mode the pipeline fetches Jolpica and OpenF1 as usual. Their 2026 answers are already final, and the pipeline only asks after a session's (simulated) end, so nobody sees a result early. The pipeline's own throttles keep it within each provider's limits.
- **Errors go to Sentry** through `@sentry/tanstackstart-react` on the server and the browser, scrubbed by one `beforeSend` that keeps codes and drops values (decision 3). The tick reports to Sentry with the same scrubber. Usage alerts reach admins by push as well as the review queue.
- **Backups are nightly `pg_dump`s** from a GitHub workflow, encrypted with `age` to a public key, and written to the existing Neon Object Storage (decision 4). The restore drill is a runbook, `docs/runbooks/restore.md`, run once on staging.
- **Load tests are scripts in `scripts/`**, like `chat-load.ts`: they're run from your machine or a workflow against staging, never in CI.

**Tech Stack:** TanStack Start, React 19, Drizzle, Postgres (PGlite in tests, Neon in staging), Zod, Vitest, Playwright with axe-core, GitHub Actions. **New dependencies (decision 3 and 4):** `@sentry/tanstackstart-react` in the app, and `age` and `pg_dump` in the backup workflow only.

**Spec:**
- [01-high-level-design.md](../design/01-high-level-design.md):
  - §4.5 (the scheduler);
  - §11.4 (free limits, usage warnings);
  - §11.5 (Sentry);
  - §12.3, §12.6 and §12.7 (replay, load, budget);
  - §13 (legal) and §15 (launch scope);
- [02-data-model.md](../design/02-data-model.md) 2.11 (settings), 6.6 (the audit log) and 6.7 (retention);
- [04-implementation-plan.md](../design/04-implementation-plan.md) M9, including "Carried from M5", "from M6", "from M7" and "from M8".

## What checking the spec turned up
I read M9's scope and its four carry-over lists, the HLD sections above, and the code they touch. These change what the roadmap says, and the tasks below follow them.

1. **Nothing can run a replay outside the tests.** The replay harness (`src/replay/`) advances `simulated_clock` from a test loop. A hosted beta needs the clock to move by itself, and staff need to pause it or skip a gap between rounds. That's Task 5.
2. **The beta can't share staging's database as it stands.** `import:2026` refuses a database that has polled live data, and staging has polled the whole 2026 season. The beta needs a fresh database (decision 1).
3. **Sign-up is closed to everyone but you** (`SIGN_UP_ALLOWED_EMAILS`). Before it opens, M5's carry-over has to land: a confirmation from a browser that isn't signed in resets a half-made sign-up. That's Task 1.
4. **Email may only reach you.** If staging's `EMAIL_FROM` uses Resend's test domain, Resend only delivers to the account owner, so beta testers would get no confirmation or magic-link email. Sending to them needs a domain you own, verified in Resend. Discord sign-in works without email (decision 2).
5. **The legal pages are placeholders** ("DRAFT 1"). Your lawyer's text can't be written by me. The beta needs beta terms of its own (decision 5).
6. **Neon Free keeps 6 hours of history and one manual snapshot,** with no scheduled backups (Neon's backup docs, checked 2026-11-22). A restore drill needs a copy older than 6 hours, so backups need somewhere to live (decision 4). GitHub artifacts are out: this repository is public.
7. **Sentry's TanStack Start SDK is labelled beta** (its changelog) or alpha (npm). It's the only SDK for the framework, and a version can be pinned (decision 3).
8. **The race-end spike has no script.** `chat-load.ts` covers chat. The spike (many people opening scores the minute a race is final) needs its own, against the cached score pages.
9. **The budget run needs a replayed weekend on hosted infrastructure,** which is the beta's environment. So the budget run happens in the beta's first weekend, not separately.
10. **Production costs money only if you buy a domain.** Neon Free and Vercel Hobby are free, and a `*.vercel.app` address works. A domain (about $10–40 a year) is your call, and it also unlocks email to testers (finding 4).
11. **Staging has a variable named `VERCEL_TOKEN`** as well as a secret of that name (names only, checked 2026-11-22). Variables print in plain text. Unless that value is already revoked, rotate it and delete the variable. Nothing in the repository reads a `VERCEL_TOKEN` variable.

## Decisions (yours)
**Answered 2026-11-22: every decision went the recommended way.**
1. The beta runs on a `beta` branch of the staging Neon project, in replay mode, after the 2026 season.
2. Testers sign in with Discord only, from an invite list.
3. Sentry, free, through a pinned `@sentry/tanstackstart-react`.
4. Nightly `pg_dump`s, encrypted with `age`, kept in Neon Object Storage.
5. A beta notice that I draft and you approve.
6. Production is created in Task 15.

These change what gets built. Each has my recommendation first.

1. **Where the closed beta runs.**
   - **Recommended: a `beta` branch on the staging Neon project, after the 2026 season.** It's created from staging's schema with no data, the 2026 season is imported fresh, and `CLOCK_MODE=replay` with a `replay_offset` runs the clock. Staging's Vercel project and the `tick` function point at `beta` for the beta's weeks, then back. It costs nothing new. Staging's 100 compute-hours a month are shared, but nothing else uses them then.
   - **Alternative A: a third free Neon project and Vercel project, `gridlocked-beta`.** It keeps staging free for other work, and has its own 100 compute-hours. It's two new cloud resources to approve and wire.
   - **Alternative B: run the beta on production,** reset before launch. It tests the real setup, but a reset is a destructive step before launch day, and beta data would sit in production's backups.
2. **How testers sign in.**
   - **Recommended: Discord only for the beta, with sign-up limited to an invite list.** The allowlist becomes Discord account ids as well as email addresses, so you invite people by their Discord ids. No domain is needed for the beta.
   - **Alternative: buy the domain now,** verify it in Resend, and open email sign-up to the invite list too. It tests the email paths (confirmation, magic links, the outbox) on real people, and it's a cost.
3. **Error reporting.**
   - **Recommended: Sentry, free Developer plan, with `@sentry/tanstackstart-react` pinned.** One `beforeSend` drops request bodies, cookies, query strings and messages, and keeps the error class, a code and the route. The tick reports the same way. You create the Sentry project and its DSN (a public value) and an auth token for source maps (a secret, names only).
   - **Alternative: no SDK.** A 40-line reporter posts the same scrubbed envelope to Sentry's store endpoint from the server only. No browser errors, no tracing, and no beta-labelled dependency.
4. **Where backups go.**
   - **Recommended: a nightly workflow, `backup.yml`.** It runs `pg_dump` with `DATABASE_URL_STAGING` (later production's), encrypts the dump with `age` to a public key you generate (you keep the private key offline), and writes it to the existing Neon Object Storage under `backups/`, keeping 14. The workflow never holds the decryption key, so a leaked workflow can't read the data.
   - **Alternative: Neon's one manual snapshot,** taken before each deploy. It's simpler, but it's only one copy, and a bad day between deploys can't be undone past 6 hours.
5. **The beta's terms.**
   - **Recommended: a short beta notice of my drafting,** shown at sign-up and accepted like the other documents. It says it's a test, the data may be wiped, and the beta ends by 5 March. Terms, Privacy and Community rules stay "DRAFT", and your lawyer's text replaces them before M10. You read the notice before anyone signs up.
   - **Alternative: wait for your lawyer's text** before the beta opens. It's cleaner, and the beta's dates then depend on the lawyer's.
6. **Production's timing.**
   - **Recommended: create production in Task 15, the last task.** A Neon Free project, `gridlocked-prod` (aws-us-east-1, 0.25 CU max), and a Vercel Hobby project, empty, with the deploy workflow, backups and Sentry wired, and a restore drill run on it. M10 then only imports 2027 and opens the doors.
   - **Alternative: create it in M10.** Nothing idles for weeks, and M10 carries the setup risk on launch week.

**My calls (lower stakes; each goes into the docs when its task lands):**
- **Beta size:** up to 30 testers, under HLD §11.4's 50 for chat on Hobby, with headroom for the load tests.
- **Beta weekends:** four, chosen for what they test: a sprint weekend, round 14 (the substitution), Mexico City (round 19, the disqualification), and Abu Dhabi (the last). The clock jumps between them.
- **The replay setting:** `replay_offset` holds whole seconds, or `paused` with the instant it stopped. Staff change it on the Settings screen with a reason, as with any setting.
- **Load test targets:**
  - race end: 500 readers opening the race's scores within 60 seconds, then refreshing every 30 seconds for 10 minutes;
  - chat: M7's 50 readers again, and 150 to see where it bends.
- **The accessibility sweep:** axe on every route at 390 and 1440 wide, logged in and out. Then a keyboard-only pass and a VoiceOver pass by hand, written up as a checklist you can repeat.
- **The security review** uses the OWASP ASVS level 1 list. Findings go in `docs/reviews/M9-security.md` with what was done about each.
- **Usage alerts by push:** a `usage_high` review item also pushes to every admin who has push on.
- **Rate limits** are tuned from the beta's own numbers, read from the audit log and `rate_limits`, not guessed.

## What each task needs from you
**Tasks 1–4 and 6–9 need no account, no key and no staging write.** They're built and tested against PGlite and a local build. Then:
- **Before Task 1:** decisions 1–6, and the stale `VERCEL_TOKEN` variable dealt with (finding 11).
- **Before Task 13:** `VERCEL_USAGE_TOKEN` in the staging environment (carried from M8), so the budget run has Vercel's numbers.
- **Task 5 (replay clock):** your OK to create the `beta` branch on the staging project (decision 1).
- **Task 10 (Sentry):** the Sentry project, its DSN and a source-map auth token, as secrets in the staging environment (names only).
- **Task 11 (backups):** an `age` key pair; the public key as a variable, the private key kept by you offline.
- **Task 12 (load tests):** one Deploy staging run, and each load run with its own OK, as in M7.
- **Task 13 (the beta):**
  - the invite list (Discord ids or addresses);
  - the beta notice read and approved;
  - one Deploy run pointed at `beta`;
  - your OK to open sign-up to the list.
- **Task 15 (production):** approval for the Neon project and the Vercel project, and a domain only if you choose one.

## Global Constraints
- **No direct time.** Every function takes `now: Date` from its caller (HLD decision 20). The replay clock changes what "now" the tick is given, never how code reads it.
- **Free plans only, no card.** Nothing in this plan needs a paid tier. A domain is the only purchase, and it's yours to choose.
- **Secrets:** Claude never creates, enters or views a secret. You create them; workflows read them by name. Nothing prints an environment.
- **No personal data leaves the app** except to Sentry, and then only scrubbed: no bodies, cookies, query strings, emails, usernames or IP addresses (DM 6.6).
- **Staging writes go through workflows**, each run started by you or with your OK in chat. Read-only queries are fine.
- **Load tests never run in CI**, and each staging run needs your OK.
- **Backups are encrypted before they leave the runner,** and the decryption key never reaches GitHub.
- **Caching:** signed-in answers stay `private, no-store`. Anything newly cached for logged-out readers is checked for a signed-in leak by a test that sends the same request with and without a session.
- **Migrations:** schema in `src/db/schema/`, then `pnpm db:generate`; `pnpm db:drift` stays clean.
- **Workflow:** one branch `m9/<issue>-<slug>` and one PR per task, closing its issue. CI green before a squash-merge. No auto-merge, no force-push.

## Review Focus
1. **A cached page served to the wrong reader.** When the public pages start caching for logged-out readers (Task 6), a signed-in reader's request must never be answered from that copy, or fill it. *Pinned in Task 6.*
2. **The replay clock moving backwards or jumping past a lock.** Changing the offset, pausing or jumping must never move the clock back, and a jump stops before any lock it would pass, so locks and reminders still happen in order. *Pinned in Task 5.*
3. **A half-made sign-up taken over.** Someone who confirms an address from a browser not signed in to that account must not inherit the password, age record or sessions the first browser made. *Pinned in Task 1.*
4. **Personal data in an error report.** An error thrown while handling a post, a sign-in or an export must reach Sentry with no body, email, username, cookie or query string. *Pinned in Task 10.*
5. **A backup that can't be restored.** A dump that's truncated, or encrypted to the wrong key, must fail the nightly run, not wait to be found in the drill. *Pinned in Task 11.*

---

## Tasks at a glance
| # | Task | Size | Needs first |
|---|---|---|---|
| 1 | Sign-up and consent before anyone else joins (M5) | M | |
| 2 | Work after a commit can't be lost, and logs say what failed (M5) | M | |
| 3 | Notifications and forum fixes (M7) | M | |
| 4 | Chat fixes and shared reveals (M7) | M | |
| 5 | The replay clock for a hosted beta | M | |
| 6 | CDN caching for logged-out readers (M6) | M | |
| 7 | Staff fixes: locks moved earlier, the dry run, M8's minors | S | |
| 8 | The accessibility sweep | M | 3, 4 |
| 9 | The security review | M | 1, 2, 6 |
| 10 | Sentry and usage alerts by push | M | 2 |
| 11 | Backups and the restore drill | M | |
| 12 | Load tests on staging | M | 6 |
| 13 | The closed beta, and the budget run on its first weekend | L | 1, 5, 10, 11, 12 |
| 14 | The beta's bug-fix pass | M | 13 |
| 15 | Production, and the exit | M | everything |

Tasks 1–7 and 11 share nothing and can run in any order. Task 13 spans the beta's weeks; Task 14 collects what it finds, one PR per fix.

### Task 1: Sign-up and consent before anyone else joins (M5)

**Files:**
- Modify: `src/identity/auth/database-hooks.ts` (or the email-confirmation hook it uses), `src/identity/consent.ts` (`pendingDocuments`), `src/identity/env.ts` (the allowlist), `src/routes/legal.$kind.tsx` (the `beta` document), DM 6.7.
- Test: `src/identity/sign-up.test.ts`, `src/identity/consent.test.ts`, `src/identity/env.test.ts`, `e2e/sign-up.spec.ts`.

**Interfaces:**
- Produces:
  - `SIGN_UP_ALLOWED_EMAILS` keeps its name and format, and gains `discord:<id>` entries;
  - a `beta` legal document kind, required at sign-up while it's published.

- [ ] **Step 1: Write the failing tests:**
  - `confirming an address from a browser not signed in to it deletes the sign-up password, the age and terms record and the other sessions, and sends the person to finish signing up`;
  - `confirming from the browser that signed up keeps everything`;
  - `pendingDocuments leaves out a document published in the future`;
  - `a Discord account on the allowlist can sign up, and one not on it is refused with sign_up_closed`;
  - e2e: `a second browser confirming the address finishes sign-up with its own password and age`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** The confirmation hook compares the confirming request's session with the account. When they differ, it runs the reset in the confirmation's transaction and redirects to `/sign-up/finish`. `pendingDocuments` filters `published_at <= now`. The allowlist parser splits entries into emails and Discord ids, and the Discord callback checks the id. DM 6.7 states Neon's history window (6 hours on Free) as the soft-delete's tail.
- [ ] **Step 4: Run `pnpm test src/identity` and the sign-up e2e.** Expected: green.
- [ ] **Step 5: Commit** `fix: sign-up and consent before sign-up opens`.

### Task 2: Work after a commit can't be lost, and logs say what failed (M5)

**Files:**
- Modify: `src/identity/auth/index.ts` (`onPasswordReset`), `src/identity/auth/database-hooks.ts`, `src/email/outbox.ts` (or where after-commit emails are queued), `src/server/server-fn-errors.ts`, `src/identity/env.ts` (`ConfigError`), `.github/workflows/deploy-staging.yml` (the Neon plan step's env).
- Test: `src/identity/after-commit.test.ts`, `src/identity/env.test.ts`, `src/server/server-fn-errors.test.ts`.

**Interfaces:**
- Produces:
  - `ConfigError` (value-free: it names the variable, never its value);
  - every log line from an auth failure carries an `IdentityErrorCode` instead of "better-auth error: event".

- [ ] **Step 1: Write the failing tests:**
  - `an audit row or email queued after Better Auth's transaction is written even when the hook after it throws`;
  - `onPasswordReset revokes the other sessions even when the reset's email fails`;
  - `a missing or malformed setting throws ConfigError naming the variable, and its message never contains the value`;
  - `an auth failure logs its code`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Audits and emails that follow a Better Auth write go through the outbox inside the same transaction where Better Auth allows it. Where it doesn't, a `job` retries them (kind `identity_after_commit`, idempotent by the user and event). `onPasswordReset` revokes first, then queues the email. The plan step gets only `NEON_API_KEY` and the project id.
- [ ] **Step 4: Run `pnpm test src/identity src/server`.** Expected: green.
- [ ] **Step 5: Commit** `fix: work after Better Auth's commit is kept, and logs carry codes`.

### Task 3: Notifications and forum fixes (M7)

**Files:**
- Modify: `src/notifications/text.ts`, `src/notifications/read.ts`, `src/notifications/lock-reminder.ts`, `src/notifications/push.ts`, `src/notifications/forum.ts`, `src/game/score-jobs.ts`, `src/community/session-threads.ts`, `src/components/community/forum-words.ts`, the notifications screen.
- Test: the matching `*.test.ts`, and `e2e/notifications.spec.ts`.

- [ ] **Step 1: Write the failing tests:**
  - `notification times show in the viewer's zone`;
  - `a failed mark-read still opens the notification`;
  - `the lock reminder writes owners in batches of 500, one transaction each, and a second run writes none twice`;
  - `signing out removes this browser's push subscription from the account`;
  - `a spoiler thread with no session shows its full title once its watch window has passed`;
  - `a results post that fails doesn't stop the scores from being saved, and is retried`;
  - `a session added after its event's threads opened gets its thread`;
  - `"You're muted until <time>" names the end, and "until lifted" when there's none`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement each.** The results post leaves the scoring transaction: scoring queues a `results_post` job in it, and the job writes the post. The lock reminder follows `game_lock`'s batching. Sign-out calls the push unsubscribe before the session ends.
- [ ] **Step 4: Run `pnpm test src/notifications src/community src/game` and the notifications e2e.** Expected: green.
- [ ] **Step 5: Commit** `fix: M7's notification and forum gaps`.

### Task 4: Chat fixes and shared reveals (M7)

**Files:**
- Modify: `src/community/chat.ts`, `src/server/chat-refresh.ts`, the chat client hook, `src/lib/shown-ids.ts`, every route that reads `?show=` (`index`, `team.$slot.*`, `leagues.$slug`, `forum.$category`, `t.$threadId`, `prices.index`).
- Test: `src/community/chat.test.ts`, `src/server/chat-refresh.test.ts`, `src/lib/shown-ids.test.ts`, `e2e/fantasy/spoilers.spec.ts`.

**Interfaces:**
- Produces: `shownIds` reads and writes `history.state.shown`, not the address. Old `?show=` links still work once, and the param is dropped from the address.

- [ ] **Step 1: Write the failing tests:**
  - `a client settles its window from its own clock offset, not the cached answer's time`;
  - `a client that missed more than 50 messages, or slept, fills the gap with chatSince before it shows new ones`;
  - `clients start their first refresh at a random point in the window`;
  - `a revealed score isn't revealed for someone who opens the copied address`;
  - `an old ?show= link reveals once and leaves the address without it`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** The refresh answer carries the window's start, and the client keeps its offset from the first answer. `chatSince` pages until it reaches the newest. The reveal moves to history state, so back and forward keep it, and a copied address doesn't.
- [ ] **Step 4: Run `pnpm test src/community src/server src/lib` and `pnpm e2e --project=fantasy`.** Expected: green.
- [ ] **Step 5: Commit** `fix: chat clocks and gaps, and reveals that don't travel`.

### Task 5: The replay clock for a hosted beta

**Files:**
- Create: `src/replay/hosted-clock.ts`.
- Modify: `src/jobs/functions/tick.ts`, `src/lib/resolve-clock.ts`, `src/settings/defaults.ts` (`replay_offset`), `src/settings/write.ts` (`EDITABLE_SETTINGS`), `src/routes/staff.settings.tsx`, `scripts/import-2026.ts` (allow an empty replay database).
- Test: `src/replay/hosted-clock.test.ts`, `src/settings/write.test.ts`, `e2e/staff-settings.spec.ts`.

**Interfaces:**
- Produces:
  - `replay_offset: { mode: "running"; seconds: number } | { mode: "paused"; at: string }`;
  - `hostedReplayNow(db, realNow): Promise<Date>`, which the tick calls in replay mode before it runs, writing `simulated_clock`;
  - `jumpReplay(db, now, actor, { to: Date, reason })`, which refuses to pass a lock.

- [ ] **Step 1: Write the failing tests:**
  - `a running offset sets the clock to real time minus the offset`;
  - `the clock never moves backwards: a smaller offset holds the clock until real time catches up`;
  - `paused holds the clock where it stopped`;
  - `a jump past a lock stops one minute before it, with jumped_to_lock`;
  - `the tick in system mode ignores replay_offset`;
  - `the import runs on an empty replay database and refuses a used one`;
  - e2e: `an admin pauses the replay and resumes it, both in the audit log`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** The offset is chosen so the first beta weekend's Friday lines up with a real Friday (Task 13 sets it). Jumping writes the offset that lands on `to`. The Settings screen shows the replay block only in replay mode.
- [ ] **Step 4: Run `pnpm test src/replay src/settings src/jobs` and the settings e2e.** Expected: green.
- [ ] **Step 5: Commit** `feat: a replay clock that runs by itself`.

### Task 6: CDN caching for logged-out readers (M6)

**Files:**
- Modify: `src/lib/public-headers.ts`, `src/server/public-cache.ts`, `vercel.json` (or Nitro's route rules), the hub, Prices and How prices work routes.
- Test: `src/lib/public-headers.test.ts`, `e2e/public-cache.spec.ts`.

**Interfaces:**
- Produces: logged-out answers are cached by Vercel's CDN; signed-in requests bypass the cache.

- [ ] **Step 1: Write the failing tests:**
  - `a request without a session cookie gets public, s-maxage=60, stale-while-revalidate=30 and no Vary: Cookie`;
  - `a request with a session cookie is never answered from, or stored in, the shared copy`;
  - `within 30 minutes of a lock the stale window drops to 10 seconds`;
  - staging check (Task 12): `x-vercel-cache: HIT` on the second logged-out request.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** A route rule sends requests carrying the session cookie to an uncached path variant (Vercel's `has: cookie` rewrite), so the public path's cache only ever sees logged-out requests and needs no `Vary: Cookie`. If Vercel's rewrites can't do that on Hobby, the fallback is a `__lo` query on every public link for logged-out readers. Rule it in the ledger.
- [ ] **Step 4: Run `pnpm test src/lib src/server` and the e2e.** Expected: green.
- [ ] **Step 5: Commit** `feat: the CDN caches public pages for logged-out readers`.

### Task 7: Staff fixes: locks moved earlier, the dry run, M8's minors

**Files:**
- Modify: `src/server/due-store.ts`, `src/staff/calendar.ts`, `src/staff/scoring.ts`, `src/game/corrections.ts`, `src/settings/defaults.ts`, `src/server/staff.ts` (`getStaffArea`), `src/community/queue-read.ts`, `src/identity/roles.ts`.
- Test: `src/staff/calendar.test.ts`, `src/staff/scoring.test.ts`, `src/settings/write.test.ts`, `src/identity/roles.test.ts`.

- [ ] **Step 1: Write the failing tests:**
  - `a lock moved earlier on a site without Object Storage keys queues a tick job at the new time`;
  - `a dry run longer than one batch continues as a job, and the screen shows it running`;
  - `a poll gap over 24 hours, more than 10 gaps, or a re-check over 168 hours is refused as invalid`;
  - `the staff area's counts come from count queries`;
  - `banning an admin is refused with cannot_ban_admin` (only if you choose that answer below).
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** The due store falls back to a `jobs` row at the lock when the site has no keys. The dry run runs per event in `dry_run` jobs. The admin-ban rule follows your answer to M8's last minor: refuse it (matching view-as-user), or leave it, and the test goes.
- [ ] **Step 4: Run `pnpm test src/staff src/settings src/identity`.** Expected: green.
- [ ] **Step 5: Commit** `fix: late locks without Object Storage, long dry runs, and M8's minors`.

### Task 8: The accessibility sweep

**Files:**
- Create: `e2e/a11y-sweep.spec.ts`, `docs/reviews/M9-accessibility.md`.
- Modify: whatever the sweep finds.

- [ ] **Step 1: Write the sweep:** every route in `routeTree.gen.ts`, at 390 and 1440 wide, logged out and as a player with a team (staff routes as an admin), runs axe with WCAG 2.1 AA rules and fails on any violation.
- [ ] **Step 2: Run it.** Expected: FAIL with a list (or PASS, which is recorded).
- [ ] **Step 3: Fix each violation,** one commit per kind. Then do a keyboard-only pass and a VoiceOver pass over the beta's main flows (sign up, build a team, the lock, a reveal, chat, a report) and write each finding in the review with what was done.
- [ ] **Step 4: Run `pnpm e2e`.** Expected: green.
- [ ] **Step 5: Commit** `test: the accessibility sweep, and its fixes`.

### Task 9: The security review

**Files:**
- Create: `docs/reviews/M9-security.md`, `e2e/security-headers.spec.ts`, `src/server/authz-matrix.test.ts`.
- Modify: whatever it finds.

- [ ] **Step 1: Write the failing tests:**
  - `every server function answers an unauthenticated call with unauthenticated, a player with forbidden where it's staff-only, and a foreign Origin with 403` (one table, every exported server function);
  - `every page sends a Content-Security-Policy, X-Content-Type-Options, Referrer-Policy and frame-ancestors 'none'`.
- [ ] **Step 2: Run them.** Expected: FAIL on the headers at least.
- [ ] **Step 3: Review against ASVS level 1** (authentication, sessions, access control, input, output encoding, files, errors and logging, data protection, configuration), write each finding in the review, and fix them, each with a test. Add the headers through Nitro's route rules, with a CSP allowing only the app's own origin, Turnstile and Sentry.
- [ ] **Step 4: Run `pnpm test` and `pnpm e2e`.** Expected: green.
- [ ] **Step 5: Commit** `fix: the security review's findings, with headers and an access matrix`.

### Task 10: Sentry and usage alerts by push

**Files:**
- Create: `src/lib/report-error.ts` (the scrubber), `src/instrument.server.ts`.
- Modify: `src/router.tsx` or the client entry, `src/jobs/functions/tick.ts`, `src/server/server-fn-errors.ts`, `src/staff/usage.ts` (`usage_high` pushes), `vite.config.ts` (source maps), `.github/workflows/deploy-staging.yml`, the CSP from Task 9.
- Test: `src/lib/report-error.test.ts`, `src/staff/usage.test.ts`.

**Interfaces:**
- Produces: `scrub(event): event | null`, used by every `beforeSend`.

- [ ] **Step 1: Write the failing tests:**
  - `scrub drops request bodies, cookies, headers, query strings, user, breadcrumbs' data and messages, and keeps the error class, code, route and release`;
  - `an error thrown while handling a post reaches the reporter with no post text, email or username in it`;
  - `a usage_high item pushes to every admin with push on, once per meter per day`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Pin `@sentry/tanstackstart-react` to an exact version. No DSN means no reporting (local and CI). Source maps upload in the deploy with the auth token, and aren't served.
- [ ] **Step 4: Run `pnpm test`, a prod build's marker check, and one staging error by hand after the next deploy.** Expected: green, and the staging error appears in Sentry scrubbed.
- [ ] **Step 5: Commit** `feat: errors reach Sentry scrubbed, and usage alerts push`.

### Task 11: Backups and the restore drill

**Files:**
- Create: `.github/workflows/backup.yml`, `scripts/backup-check.ts`, `docs/runbooks/restore.md`.
- Test: `scripts/backup-check.test.ts`.

- [ ] **Step 1: Write the failing tests:** `backup-check refuses a dump with no closing marker, one under the size floor, or one that isn't age-encrypted`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** At 04:00 UTC, the workflow runs `pg_dump --format=custom` and checks it with `pg_restore --list`, then encrypts it with `age -r <public key>` and checks the result. It uploads the dump to `backups/<env>/<date>.dump.age` and deletes copies past 14. A failed check fails the run. The runbook covers: fetch a dump, decrypt it on your machine, restore it into a new Neon branch, check the row counts against the source, and delete the branch.
- [ ] **Step 4: Run the tests; then, with your OK, one workflow run on staging and the drill by the runbook,** with you holding the private key. Expected: green, and the drill's counts match.
- [ ] **Step 5: Commit** `feat: nightly encrypted backups and the restore runbook`.

### Task 12: Load tests on staging

**Files:**
- Create: `scripts/race-end-load.ts`, `docs/reviews/M9-load.md`.
- Modify: `scripts/chat-load.ts` (readers as a flag).
- Test: `scripts/race-end-load.test.ts` (the request plan only, against a fake fetch).

- [ ] **Step 1: Write the failing test:** `the race-end plan opens the scores page for N readers within the ramp, then refreshes every interval, and reports HIT, MISS and status counts and latency percentiles`.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement the script,** like `chat-load.ts`.
- [ ] **Step 4: With your OK, deploy staging and run:** the race end at 500 readers, and chat at 50 and 150. Record requests, HIT/MISS, function invocations and latency in the review, against Hobby's limits. If chat still misses more than twice a window (M7's 2.7), collapse the first requests of a window: the client asks for the next window's address a moment before it starts. Test it, deploy it, and run chat again.
- [ ] **Step 5: Commit** `test: race-end and chat load on staging`.

### Task 13: The closed beta, and the budget run on its first weekend

**Files:**
- Create: `docs/reviews/M9-beta.md`, `docs/runbooks/beta.md`.
- Modify: `.github/workflows/deploy-staging.yml` (a `target: main | beta` input), `neon.ts`.

- [ ] **Step 1: With your OK, create the `beta` branch,** deploy with `target=beta`, import 2026, set `CLOCK_MODE=replay`, and set the offset so the first beta weekend's Friday lands on a real Friday.

  *Changed 2026-11-24 (your answer, "From round 1").* The import loads every result at once, so the beta doesn't use it. The deploy seeds the game from round 1 with no results (`pnpm seed:beta`), starts the clock, and publishes the notice. The branch is schema-only. The steps are in [docs/runbooks/beta.md](../runbooks/beta.md).
- [ ] **Step 2: You approve the beta notice, and open sign-up to the invite list.**
- [ ] **Step 3: The budget run,** on the first beta weekend and the quiet week after it: Neon compute-hours and transfer, function invocations, Vercel usage and emails, read from the usage meters and the providers' dashboards, against HLD §11.4's free limits. It also measures (carried from M5 and M7):
  - the per-request cost of `ensureProfile` and `betterAuth()`;
  - a session thread's page, which loads every post.

  It checks the Vercel CPU meter's row names against the real reading (M8). Record it all in the beta review, with a fix for anything over budget.
- [ ] **Step 4: The two staging checks M5 couldn't run,** with testers' consent: a second account deleted, which then can't sign in; and an export link still working on day 6.
- [ ] **Step 5: Run the four weekends.** For each, write down in the beta review what testers reported, what Sentry caught, and the rate-limit refusals. Tune the rate limits from those numbers.
- [ ] **Step 6: Commit** `docs: the closed beta and its budget run`.

### Task 14: The beta's bug-fix pass

- [ ] One issue per bug the beta finds, each fixed test-first in its own PR, or carried to M10 by name with a reason. The beta review lists each with where it went.

### Task 15: Production, and the exit

**Files:**
- Create: `.github/workflows/deploy-production.yml` (manual, `production` environment, required reviewer: you).
- Modify: `docs/design/04-implementation-plan.md` (M9's result), `backup.yml` (production).

- [ ] **Step 1: With your approval, create the Neon project `gridlocked-prod`** (Free, aws-us-east-1, autoscaling capped at 0.25 CU) **and the Vercel Hobby project.** You put their secrets in the `production` environment.
- [ ] **Step 2: Deploy production empty** (migrations, the `tick` with its triggers, the site), with backups, Sentry and the usage snapshot pointed at it. Sign-up stays closed.
- [ ] **Step 3: Run the restore drill on production's first backup.**
- [ ] **Step 4: Point staging back at `main`,** and keep the `beta` branch until you say so.
- [ ] **Step 5: Your lawyer's documents.** When you have the text, it replaces the drafts as new versions, so everyone accepts it again at their next visit. If it isn't ready, the result carries it to M10 with a date.
- [ ] **Step 6: Record M9's result** in the roadmap, with what's carried to M10. Commit `docs: M9's result`.
