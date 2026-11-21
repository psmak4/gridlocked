# M8 Staff Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a normal weekend needs no staff, and an abnormal one is quick to fix (roadmap M8, epic psmak4/gridlocked#9).

**Exit:**
- the roadmap's three key tests pass:
  - every staff write is audited with a reason;
  - a lock never moves into the past;
  - two staff can't resolve the same item;
- every wave 5 board has a screen and a phone-size and desktop e2e test;
- every review item kind the code opens has its copy and its actions, or is dismissable with a reason;
- the carry-overs from M5, M6 and M7 are done or ruled on;
- staging runs the staff screens, and one real staff flow is walked through there with your OK.

**Architecture:**
- **One staff area, `/staff`.** It's a layout route with wave 5's side menu, guarded twice:
  - the route's `beforeLoad` sends a locked session to `/settings/security`;
  - every staff server function calls `requireStaff` itself.

  The route guard is for the screen. The function guard is the one that counts.
- **Staff functions keep M7's shape:** `(db, now, actor, input) → plain object`, in `src/staff/`, tested on PGlite without the Start runtime. `src/server/staff.ts` wraps them in Zod-checked `createServerFn`s through one helper, `staffFn` (Task 3). That helper:
  - resolves `now` once;
  - runs `requireStaff` at the function's role;
  - gives the request an id;
  - maps every refusal to a `StaffErrorCode`.
- **Every write goes through what already exists where it can:** `changeSeats`, `recordSubstitution`, `overrideResult`, `insertResult`, `dryRunGame`, `approveRescore`, `moderate`, `setRole`, `banUser` and `setTrustLevel`. M8 adds only the writes nothing has yet: lock times, session times and status, event cancellation, availability, override revocation, admin prices, settings and review resolution.
- **Optimistic concurrency in one place.** A queue item is resolved by `update … where id = $1 and version = $2 and status = 'open'`. No row back means someone got there first (`stale`), and the screen reloads the item with words. Review items and moderation queue items both use it.
- **The audit log's actions become a typed list.** `writeAudit`'s `action` is `AuditAction`, a key of `AUDIT_ACTIONS` (Task 4), each with its screen label. An action without a label doesn't compile, so the audit screen can always name what happened.
- **Review item kinds become a typed list too.** `openReviewItem`'s `kind` is `ReviewKind`, a key of `REVIEW_KINDS` (Task 10), each with its title, summary and actions. A kind the queue can't show doesn't compile.

**Tech Stack:** TanStack Start, React 19, Drizzle, Postgres (PGlite in tests, Neon in staging), Zod, the design-system components (Switch, Tabs, Badge, Button and TextField are built), Tailwind 4, Vitest, Playwright with axe-core. **No new dependencies.**

**Spec:**
- [03-ui-brief.md](../design/03-ui-brief.md) wave 5 and its canvas [Gridlocked wave 5](https://claude.ai/artifact/1jEacvWbtfdQ1DNo9Yv52D), for the nine boards' layout and copy;
- [02-data-model.md](../design/02-data-model.md):
  - 1.3 and 1.4 (lock times and session status);
  - 1.8 and 1.10 (seats and availability);
  - 2.6 and 2.9 (overrides and review items);
  - 2.11 (settings);
  - 3.5 (prices);
  - 4.9 (corrections);
  - 5.9 (moderation);
  - 6.4 and 6.6 (staff security and the audit log);
- [01-high-level-design.md](../design/01-high-level-design.md) §4.4, §8 and §11.4 (point 7: usage warnings at about 70%);
- [04-implementation-plan.md](../design/04-implementation-plan.md) M8, including "Carried from M5", "from M6" and "from M7".

## What checking the spec turned up
I read wave 5's nine boards, the DM sections above, and the staff code that M2 to M7 left behind. These change what the roadmap says, and the tasks below follow them.

1. **Most staff writes already exist.** They're reached today through `pnpm staff` and the Staff action workflow:
   - seats and substitutions;
   - overrides and inserts;
   - moderation;
   - roles;
   - bans;
   - trust levels;
   - the dry run and approval.

   M8 is mostly screens on them.
2. **Some writes don't exist at all:**
   - Nothing moves a lock by hand. The database already refuses one moving into the past (`events_lock_at_guard`, migration 0017). `lock_at_source = 'admin'` is honoured by the sync, but nothing sets it.
   - Nothing sets a session `suspended`, `cancelled` or `abandoned` (the M7 carry-over), and nothing marks an event cancelled. Only the replay harness does.
   - Nothing sets `driver_availability` apart from the season import.
   - Nothing revokes an override.
   - Nothing writes a setting: `getSetting` reads, and there's no `setSetting`.
3. **Review items have no way to close but a job's.** Only jobs resolve them, through `reconcileWarnings` and an `AUTO_RESOLUTION`. About 30 kinds are opened across `src/`, with free-text `kind`. The queue needs each one's copy and actions, so the kinds become a typed list (architecture).
4. **Prices publish themselves.** `finalizeGameEvent` runs `runPriceUpdate`, which publishes (DM 3.5). The board shows a **Publish prices** button, which would add a person to every normal weekend. That works against M8's goal (decision 1).
5. **Usage meters need numbers the app doesn't have.** Neon's compute and transfer, and Vercel's function time, come from the providers' APIs, which need keys. The app only counts its own emails (decision 2).
6. **The rulesets editor and user lookup weren't designed** (wave 5, "Not designed"). User lookup is needed anyway: role changes, bans, trust levels and impersonation all start from a user, and M5's carry-over asks for `requireStaff` before them on a screen. So Task 12 builds it from the boards' patterns. The rulesets editor is decision 3.
7. **Two board items have nothing behind them:**
   - "Forum search" is a feature flag, but search waits for after launch (M7 decision 2);
   - "Spoiler window (days)" is a pipeline setting, but spoilers are per viewer (watch marks), with no window.

   Both are left off the screens.
8. **The audit board shows an actor's name** ("preston", "mod_kate"). The log stores `actor_user_id`, so the screen joins `profiles.username`, and a deleted actor shows as "deleted user" (DM 5.1). `actor_label` covers the staff workflow, and "Job" covers `job` and `system`.
9. **Reopening a final session isn't something the model allows.** The results board has **Reopen session**, but DM 2.3 makes `final` final: a correction re-scores it instead. The screen has **Check provider again** and corrections, and no reopen.
10. **M7's moderation has four gaps** (roadmap "Carried from M7"). One is a model change: chat bans get their own lift, `chat_unban`, which joins DM 5.9's action list.

## Decisions (yours)
**Answered 2026-11-21: every decision went the recommended way.**
1. Prices publish automatically.
2. A daily `usage-snapshot.yml` feeds the meters. You'll create `VERCEL_USAGE_TOKEN` before Task 14, and its scheduled staging write has your standing OK.
3. The rulesets editor waits, and `correct-ruleset` comes now.
4. Chat and push are the only flags.
5. `pnpm staff` and the workflow stay.

These change what gets built. Each has my recommendation first.

1. **Price publishing.**
   - **Recommended: keep it automatic.** The Prices screen shows the next event's list with each asset's inputs (last-3 average, what its price expects, how it did) and the change, whether it's published, and the carry-over rule. **Change one by hand** sets an `admin` price with a reason while the event is `upcoming`. The board's **Publish prices** becomes a status line ("Published when the United States GP became final"). A normal weekend then needs nobody.
   - **Alternative: a staff approval before publishing.** `runPriceUpdate` writes the rows unpublished, and **Publish prices** sets `prices_ready_at`. If nobody presses it before the window opens, the carry-over rule applies, which could happen on any weekend nobody's watching.
2. **Where the usage meters' numbers come from.**
   - **Recommended: a daily GitHub workflow, `usage-snapshot.yml`.** It runs at 05:00 UTC and reads Neon's consumption API with the existing `NEON_API_KEY_STAGING`, and Vercel's usage API with a new `VERCEL_USAGE_TOKEN` you create (read-only scope, names only). It writes one `usage_snapshots` row through `DATABASE_URL_STAGING`. No provider key goes into the app. A meter over 70% opens a warning review item (HLD §11.4). Email counts come from `email_outbox` directly. It's a scheduled staging write, so it needs your standing OK once, which is the reason to choose it knowingly.
   - **Alternative A: only what the app counts itself.** That's emails today, job runs and chat refreshes, with links to the Neon and Vercel dashboards for the rest. No new secret, no scheduled write, and no 70% alert for compute.
   - **Alternative B: the scheduler tick fetches usage itself,** with the Neon key in the function's environment. It's simplest to run, but a full-access Neon key would live in the runtime.
3. **The rulesets editor.**
   - **Recommended: later (M9 or after launch), with a workflow command now.** M8 shows each game's ruleset versions read-only on the Scoring screen. `pnpm staff correct-ruleset` (Staff action workflow, JSON input like `override`) reaches `publishCorrectionVersion`, which has no way in today. A misconfigured rule is rare, and an editor for every rule kind is a milestone of its own.
   - **Alternative: build the editor in M8.** It's a form per rule kind (seven kinds in `src/scoring/rules.ts`), with a diff against the version it corrects. That's about two more L tasks.
4. **Feature flags.**
   - **Recommended: two real switches, chat and push, in a `feature_flags` setting.**
     - Chat off: a session thread stays in discussion mode, and the refresh answers 404.
     - Push off: nothing is sent, and in-app notifications carry on.

     Notification emails and ads are shown locked off with the board's reasons, with no switch behind them. Search isn't shown (finding 7).
   - **Alternative: a general flags table** (key, on/off, audience) for flags not yet thought of. It's more flexible, but nothing needs it yet, and every flag needs code to read it anyway.
5. **`pnpm staff` and the Staff action workflow once the screens exist.**
   - **Recommended: keep both, as the way in when the site is down or a screen is broken.** They call the same functions, so they cost nothing to keep. They gain `correct-ruleset` (decision 3) and nothing else.
   - **Alternative: retire them in M8,** so there's one way to make each change. A staff member locked out of the site then has no way to act.

**My calls (lower stakes; each goes into the DM or UI brief when its task lands):**
- **Routes:** `/staff` redirects to `/staff/review`. The others are:
  - `/staff/review` and `/staff/review/$itemId`;
  - `/staff/results/$sessionId`;
  - `/staff/scoring`;
  - `/staff/moderation` and `/staff/moderation/$itemId`;
  - `/staff/calendar` and `/staff/calendar/$eventId`;
  - `/staff/seats`;
  - `/staff/prices`;
  - `/staff/users` and `/staff/users/$username`;
  - `/staff/settings`;
  - `/staff/audit`.

  The side menu follows the board's order, with Users after Moderation.
- **Who sees what:**
  - moderators get Moderation, and Users without role changes, bans or impersonation (`ROLE_PERMISSIONS` already says this);
  - everything else is admin-only, the audit log included, since it holds security events.

  A moderator's menu shows only their screens.
- **The way in:** a "Staff tools" link on the profile for staff, and nowhere else. The staff area has no bottom nav and isn't linked from public pages.
- **Reasons:**
  - every staff write takes a reason, required and not blank, at most 500 characters;
  - the label says who sees it. "Reason (saved in the audit log)" is staff-only, and "Reason (players see this)" is for corrections and availability notes;
  - moderation's note to the author is the reason (the board's label).
- **Stale items:** a refused resolve says "Someone else dealt with this first." and shows the item as it now stands.
- **Lock times:**
  - the Calendar board's choice is between following a session (the default, `lock_at_source = default`) and setting a time by hand (`admin`);
  - a new lock in the past is refused before the database's guard is reached: "A lock can't move to a time that has passed.";
  - going back to following the session is audited too.
- **Session status:** staff set `suspended`, `abandoned`, `cancelled` and back to `scheduled`. `live` and `completed` stay the clock's. A cancelled session:
  - is skipped by the game (`setSessionException` with `skip`);
  - gets no results post;
  - turns its thread to discussion mode.
- **Event cancellation:** "Mark cancelled" (from the queue or the Calendar screen) sets `events.status = 'cancelled'` with a reason, cancels its sessions as above, and runs `planGameEvents`, which does the game's part (DM 3.9: chips refunded). Nothing is deleted. There's no un-cancel in M8.
- **Availability:**
  - statuses are `available`, `doubtful`, `unavailable` and `reserve` (DM 1.10), with a note players see;
  - saving notifies the owners of that driver for that event in-app, plus push for those who have it on (the board's line), as a new personal kind `availability`;
  - the notice is spoiler-free, since it's about a coming event.
- **Moderation queue tabs:** Open, Auto-hidden (open items whose content is `hidden_by_flags`) and Done (`actioned` or `dismissed`, newest first, 50 a page).
- **The audit log screen:**
  - filters by who (everyone, a staff member, jobs) and by what (results and scoring, moderation, season data, security), from each action's group in `AUDIT_ACTIONS`;
  - pages of 50, newest first, by `id` (UUIDv7);
  - `before` and `after` are shown as "field: old → new" for the changed fields only.
- **Usage meters** (decision 2's numbers):
  - Neon compute-hours and transfer for the month;
  - Vercel function CPU for the month;
  - account emails today against `email_caps`.

  They warn at 70% and show "Fine" below.

## What each task needs from you
**Tasks 1–13 need no account, no key and no staging write.** They're built and tested against PGlite and a local build. Then:
- **Before Task 1:** decisions 1–5.
- **Task 14:** if decision 2 is the recommended one:
  - `VERCEL_USAGE_TOKEN` as a secret in the `staging` environment (names only);
  - your standing OK for the daily `usage-snapshot.yml` write.
- **Task 15:**
  - one Deploy staging run, with your OK;
  - a staff walk-through on staging (a lock moved, a review item resolved, a setting changed), with its own OK, using your own admin account, which you unlock with your code.

## Global Constraints
- **No direct time.** Every function takes `now: Date` from its caller (HLD decision 20); server functions resolve it once.
- **Every staff write is one transaction with its `audit_log` row** (DM 0.4), with a non-blank reason and the request id. Personal fields are redacted by `writeAudit` (DM 6.6).
- **Guards:** every staff server function calls `requireStaff(viewer, role)` first, then validates its input with Zod. An impersonated session is refused (`read_only`). Moderator functions take `"moderator"`, everything else `"admin"`.
- **Optimistic concurrency** on `review_items` and `mod_queue_items`: the resolve names the version it read, and a mismatch writes nothing and returns `stale`.
- **The database still judges:** the lock guard, the price freeze and the ruleset freeze stay triggers. Code refuses first with words, but never instead of the trigger.
- **Refusals** come back as `{ ok: false, error: StaffErrorCode }`. The screen maps each to words, and anything else is `server_error`.
- **Caching:** every staff page and answer is `private, no-store`.
- **Spoilers:** staff screens show results, since staff need them. They're never linked from a public page, and a staff notification or push never carries a result.
- **UI:** design-system components and tokens only, with targets of at least 44 px and body text of 16 px. Desktop-first at 1440, stacking to one column on a phone (wave 5). Copy follows the canvas. No F1 marks.
- **Migrations:** schema in `src/db/schema/`, then `pnpm db:generate`; `pnpm db:drift` stays clean.
- **Workflow:** one branch `m8/<issue>-<slug>` and one PR per task, closing its issue. CI green before a squash-merge. No auto-merge, no force-push.

## Review Focus
1. **Two staff at once.** Two admins open the same review item, or two moderators the same report, and both press a button. Expected:
   - one wins;
   - the other gets "Someone else dealt with this first." and nothing of theirs is written (no audit row, no seat change, no restriction).

   *Pinned in Tasks 3, 10 and 11.*
2. **A lock near now.** An admin sets a lock a minute ahead, and saves after it has passed; or moves a lock that has already passed. Expected: refused with words, the event unchanged, teams saved before still counting. *Pinned in Task 5.*
3. **A locked or impersonated session reaching a staff function directly**, without the screen: an unverified session, a session whose staff role was removed a moment ago, or an admin impersonating a moderator. Expected: refused every time, by the function, with nothing written. *Pinned in Tasks 2 and 3.*
4. **A setting that breaks the pipeline.** An empty poll schedule, a finalizer check of 0 hours, or a value the schema refuses. Expected:
   - refused at save with words;
   - `getSetting` never meets a stored value it can't parse.

   *Pinned in Task 13.*
5. **A queue action on something that has moved on:**
   - "Mark cancelled" on an event that has since locked;
   - "Update seats" after the season has been renumbered;
   - a report on a post since deleted by its author.

   Expected: the action refuses or does the right thing for the current state, and never acts on what the item said when it was opened. *Pinned in Tasks 10 and 11.*

---

## Tasks at a glance
| # | Task | Size | Needs first |
|---|---|---|---|
| 1 | Carry-overs: M7's moderation fixes and M6's standings paging | M | |
| 2 | Carry-overs: two-step replay, failed codes, staff guards | S | |
| 3 | The staff area: routes, menu, `staffFn`, versioned resolve | M | 2 |
| 4 | The audit log: typed actions and its screen | M | 3 |
| 5 | Calendar, lock times and session status | L | 4 |
| 6 | Drivers, seats and availability | M | 4 |
| 7 | Session results and corrections | M | 4 |
| 8 | Scoring: the dry run, approval and ruleset versions | M | 4 |
| 9 | Prices | S | 4 |
| 10 | The review queue | L | 5, 6, 7 |
| 11 | The moderation queue | M | 1, 4 |
| 12 | Users: lookup, roles, bans, trust and impersonation | M | 4 |
| 13 | Settings and feature flags | M | 4 |
| 14 | Usage meters | M | 13 |
| 15 | The exit: every board, staging and a staff walk-through | M | everything |

Tasks 1 and 2 share nothing and can run together. After Task 4, Tasks 5–9 and 11–13 are independent of each other. Each adds its own `AUDIT_ACTIONS` entries and side-menu screen, so they merge one at a time, rebasing on main's list by merging main in.

### Task 1: Carry-overs: M7's moderation fixes and M6's standings paging

**Files:**
- Modify: `src/community/moderate.ts`, `src/community/moderation.ts`, `src/community/archive.ts`, `src/db/schema/community.ts` (the `chat_unban` value), one migration, `src/play/standings.ts`, `src/components/play/standings-screen.tsx`, DM 5.9.
- Test: `src/community/moderate.test.ts`, `src/community/archive.test.ts`, `src/play/standings.test.ts`.

**Interfaces:**
- Produces:
  - `chat_unban` in `MOD_ACTIONS`, acting on `user`;
  - `standingsPage` input gains `version: string | null`, and its result `version: string` and `restarted: boolean`.

- [ ] **Step 1: Write the failing tests:**
  - `unmute lifts a mute and leaves a chat ban in place`;
  - `chat_unban lifts a chat ban and leaves a mute in place`;
  - `restoring a removed thread that was locked restores it locked`;
  - `an action names a queue item about a different target: refused with item_mismatch, nothing written`;
  - `the chat archive closes an open queue item about a message it archives, as dismissed with "archived before review", and keeps its snapshot`;
  - `See more with the version of the first page returns the next rows of that table`;
  - `See more after an event is scored returns restarted: true and the new table's first page`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Fix each:**
  - unmute lifts only `mute` restrictions;
  - `chat_unban` lifts only `chat_ban`;
  - `remove` on a thread records its status in `before`, and `restore` puts that status back;
  - `moderate` checks that `queueItemId`'s target is the action's target;
  - the archive job resolves open items for the messages it moves, in the same transaction;
  - the standings version is the newest `team_event_totals` scoring run id the table reads. The screen sends it back with "See more" and says "The table changed. Here's the new one." when `restarted`.
- [ ] **Step 4: Run `pnpm test src/community src/play` and `pnpm db:drift`.** Expected: green and clean.
- [ ] **Step 5: Commit** `fix: M7's moderation gaps and M6's standings paging`.

### Task 2: Carry-overs: two-step replay, failed codes, staff guards

**Files:**
- Modify: `src/identity/staff-access.ts`, `src/db/schema/identity.ts`, one migration, `src/identity/roles.ts`, `src/identity/impersonation.ts`, DM 6.4.
- Test: `src/identity/staff-access.test.ts`, `src/identity/roles.test.ts`.

**Interfaces:**
- Produces:
  - table `staff_totp_steps (user_id uuid PK → users ON DELETE CASCADE, last_step bigint not null)`;
  - audit actions `staff.session.verify_failed` and `staff.session.verify_locked`;
  - `setRole`, `banUser` and `unbanUser` take `viewer: Viewer` and call `requireStaff(viewer, "admin")` themselves.

- [ ] **Step 1: Write the failing tests:**
  - `a TOTP code accepted once is refused the second time within its window`;
  - `a code for an earlier step than the last accepted one is refused`;
  - `a wrong code writes staff.session.verify_failed with the method tried and no code`;
  - `the fifth failure in the window also writes staff.session.verify_locked and opens a warning review item staff_verify_locked for the user`;
  - `setRole from an unverified session is refused with staff_session_unverified, nothing written`;
  - `banUser from an impersonated session is refused with read_only`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `totpMatches` returns the matched step. The step is accepted only if it's greater than `last_step`, and `last_step` is upserted in the same transaction as `staff_verified_at`.
  - The failure audit is written in its own transaction, since the main one writes nothing.
  - `pnpm staff set-role` keeps working: it acts as the workflow, which isn't a viewer, so `roles.ts` keeps an internal `setRoleAs(actor)` used by the CLI only.
- [ ] **Step 4: Run `pnpm test src/identity src/staff`.** Expected: green.
- [ ] **Step 5: Commit** `fix: two-step replay, failed-code audit, and staff guards on role changes`.

### Task 3: The staff area: routes, menu, `staffFn`, versioned resolve

**Files:**
- Create:
  - `src/routes/staff.tsx` (the layout);
  - `src/routes/staff.index.tsx`;
  - `src/components/staff/staff-shell.tsx`;
  - `src/components/staff/reason-field.tsx`;
  - `src/server/staff-fn.ts`;
  - `src/server/staff.ts` (empty of functions until Task 4; every later task adds its own);
  - `src/staff/errors.ts`;
  - `src/staff/versioned.ts`.
- Modify: `src/routes/profile.tsx` (the "Staff tools" link).
- Test: `src/staff/versioned.test.ts`, `src/server/staff-fn.test.ts`, `src/components/staff/staff-shell.test.tsx`, `e2e/staff.spec.ts`.

**Interfaces:**
- Produces:
  - `STAFF_ERROR_CODES`: `forbidden`, `read_only`, `staff_two_factor_required`, `staff_session_unverified`, `reason_required`, `stale`, `not_found`, `invalid`, `lock_in_past`, `item_mismatch`, `server_error`, plus a task's own codes as it adds them;
  - `staffFn({ role, input, handler })`, which returns a server function whose answer is `{ ok: true, value } | { ok: false, error: StaffErrorCode }`;
  - `resolveVersioned(tx, table, { id, version }, set): Promise<boolean>`, true when it updated, for any table with `id`, `version` and `status`;
  - `StaffShell({ menu, current, children })`;
  - `ReasonField({ label, value, onChange })` (required, at most 500).

- [ ] **Step 1: Write the failing tests:**
  - `resolveVersioned updates an open item at its version and bumps the version`;
  - `resolveVersioned with an old version updates nothing and returns false`;
  - `two resolveVersioned calls at the same version in parallel transactions: exactly one returns true`;
  - `staffFn refuses an unverified session before parsing the input`;
  - `staffFn turns an IdentityError into its code and any other error into server_error`;
  - `the menu shows a moderator Moderation and Users only`;
  - e2e `a locked staff session is sent to the security page`, `a user is refused /staff`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The layout's `beforeLoad` reads the viewer and redirects to `/settings/security`, or to `/` for non-staff.
  - The shell is the board's side menu: "GRIDLOCKED · STAFF", the items, counts from Tasks 10 and 11, and "Signed in as <username> · <role> · 2-step on".
- [ ] **Step 4: Run `pnpm test src/staff src/server src/components/staff` and `pnpm e2e staff`.** Expected: green.
- [ ] **Step 5: Commit** `feat: the staff area and its guards`.

### Task 4: The audit log: typed actions and its screen

**Files:**
- Create: `src/audit/actions.ts`, `src/audit/read.ts`, `src/routes/staff.audit.tsx`.
- Modify: `src/audit/log.ts` (`action: AuditAction`), and every `writeAudit` caller's literal (unchanged strings; only the type).
- Test: `src/audit/actions.test.ts`, `src/audit/read.test.ts`, `e2e/staff-audit.spec.ts`.

**Interfaces:**
- Produces:
  - `AUDIT_ACTIONS: Record<string, { label: string; group: "results" | "moderation" | "season" | "security" | "settings" }>` and `type AuditAction = keyof typeof AUDIT_ACTIONS`;
  - `auditPage(db, { who?: "jobs" | string; group?; before?: string }) → { rows: AuditRow[]; next: string | null }`;
  - `AuditRow = { id, when, who, what, on, change, reason }`.

- [ ] **Step 1: Write the failing tests:**
  - `every AUDIT_ACTIONS entry has a label and a group` (and `tsc` refuses an unlisted action, checked by a `@ts-expect-error` line in the test);
  - `auditPage returns 50 newest first and a cursor`;
  - `a deleted actor shows as deleted user; a job as Job; the workflow by its label`;
  - `change shows only changed fields as field: old → new`;
  - `filtering by group moderation returns only moderation actions`;
  - e2e `the audit log lists a staff change with its reason, and has no edit control`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Gather every action string written today (`grep -rn 'action: "' src`) into `AUDIT_ACTIONS` with board-style labels ("Seat change", "Prices published", "Post removed"). The screen is the board's table with the two filters and the board's line: "Every staff change and security event. Nothing here can be edited or deleted. Emails and IP addresses are never stored."
- [ ] **Step 4: Run `pnpm typecheck`, `pnpm test src/audit` and `pnpm e2e staff-audit`.** Expected: green.
- [ ] **Step 5: Commit** `feat: typed audit actions and the audit log screen`.

### Task 5: Calendar, lock times and session status

**Files:**
- Create: `src/staff/calendar.ts`, `src/routes/staff.calendar.tsx`, `src/routes/staff.calendar.$eventId.tsx`.
- Modify: `src/server/staff.ts`, `src/audit/actions.ts`, `src/community/session-threads.ts` (a cancelled session), DM 1.3 and 1.4.
- Test: `src/staff/calendar.test.ts`, `e2e/staff-calendar.spec.ts`.

**Interfaces:**
- Consumes: `enqueueCalendarSync`, `setSessionException`, `planGameEvents`, `republishIfEarlier`.
- Produces:
  - `setLockAt(db, now, actor, { eventId, lockAt, reason })`;
  - `followLockSession(db, now, actor, { eventId, reason })`;
  - `setSessionTimes(db, now, actor, { sessionId, start, end, reason })`;
  - `setSessionStatus(db, now, actor, { sessionId, status: "scheduled" | "suspended" | "abandoned" | "cancelled", reason })`;
  - `cancelEvent(db, now, actor, { eventId, reason })`;
  - `calendarList(db, seasonYear)`, `eventDetail(db, eventId)`.

- [ ] **Step 1: Write the failing tests:**
  - `setLockAt in the past is refused with lock_in_past, the event unchanged`;
  - `setLockAt on a lock that has passed is refused with lock_in_past`;
  - `setLockAt sets lock_at_source admin, audits event.lock_at.update, and moves the due-times file earlier`;
  - `the next calendar sync leaves an admin lock alone`;
  - `followLockSession puts the lock back on its session's start and the source back to default`;
  - `setSessionTimes on a lock session with a default lock moves the lock with it`;
  - `setSessionStatus cancelled skips the session for every running game and its thread gets no results post`;
  - `setSessionStatus suspended keeps the thread in chat mode past its end`;
  - `cancelEvent cancels its sessions, refunds a chip played for it, and audits event.cancel`;
  - `cancelEvent on an event that has locked is refused with event_locked`;
  - e2e `move a lock by hand, then follow the session again, and both show in History`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** The screen is the board:
  - the table (RD, EVENT, DATES, LOCK (UTC), STATUS) with **Sync now**;
  - the editing panel, with "Team locks at the start of" or "Set the lock time by hand", the lock rule line and the reason;
  - History, from the event's audit rows.

  Session rows in the panel take times and a status.
- [ ] **Step 4: Run `pnpm test src/staff src/community` and `pnpm e2e staff-calendar`.** Expected: green.
- [ ] **Step 5: Commit** `feat: calendar, lock times and session status for staff`.

### Task 6: Drivers, seats and availability

**Files:**
- Create: `src/staff/availability.ts`, `src/routes/staff.seats.tsx`, `src/notifications/availability.ts`.
- Modify: `src/server/staff.ts`, `src/audit/actions.ts`, `src/notifications/kinds.ts` (`availability`), DM 1.10 and 5.11.
- Test: `src/staff/availability.test.ts`, `src/notifications/availability.test.ts`, `e2e/staff-seats.spec.ts`.

**Interfaces:**
- Consumes: `changeSeats`, `recordSubstitution`, `revalidateEvent`.
- Produces:
  - `setAvailability(db, now, actor, { eventId, driverId, status, note, reason }) → { owners: number }`;
  - `seatTable(db, seasonYear, team?)`;
  - `availabilityFor(db, eventId)`.

- [ ] **Step 1: Write the failing tests:**
  - `setAvailability writes the row, audits driver_availability.update with before and after, and notifies each owner once`;
  - `setAvailability with the same status and note writes nothing and notifies no one`;
  - `setAvailability for an event that has locked is refused with event_locked`;
  - `an availability notice carries no result and links to the team page`;
  - `seatTable shows seats as date ranges with rounds, and an open seat as Open`;
  - e2e `move a driver from a date, and the table shows the closed seat and the new one`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** The screen is the board:
  - the seat table with the team tabs, **Move a driver from a date** (`changeSeats`) and **Add a new driver** (`recordSubstitution`);
  - the availability panel for the next event, with "Shown to players as warnings. Points always come from the results." and the owner count line.
- [ ] **Step 4: Run `pnpm test src/staff src/notifications` and `pnpm e2e staff-seats`.** Expected: green.
- [ ] **Step 5: Commit** `feat: seats and availability for staff`.

### Task 7: Session results and corrections

**Files:**
- Create: `src/staff/session-results.ts`, `src/routes/staff.results.$sessionId.tsx`.
- Modify: `src/staff/results.ts` (`revokeOverride`, `suppressResult`), `src/server/staff.ts`, `src/audit/actions.ts`.
- Test: `src/staff/session-results.test.ts`, `src/staff/results.test.ts`, `e2e/staff-results.spec.ts`.

**Interfaces:**
- Consumes: `overrideResult`, `insertResult`, `effective_results`, `result_changes`, `revalidateEvent`, the poll job's enqueue.
- Produces:
  - `sessionResults(db, sessionId) → { rows, changes, overrides, status, source, owners }`;
  - `revokeOverride(db, now, actor, { overrideId, reason })`;
  - `suppressResult(db, now, actor, { sessionId, driverId, reason })`;
  - `checkProviderAgain(db, now, actor, { sessionId })`.

- [ ] **Step 1: Write the failing tests:**
  - `sessionResults marks overridden rows and lists result_changes newest first`;
  - `revokeOverride brings back the provider value and re-scores the session`;
  - `revokeOverride on a revoked override is refused with not_found`;
  - `suppressResult hides a bogus provider row and audits result_override.create`;
  - `owners counts teams that own the driver or their constructor for the event`;
  - `checkProviderAgain queues one poll, deduped`;
  - e2e `add a correction, see it marked, then revoke it`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** The screen is the board:
  - the table (POS, DRIVER, CAR, GRID, STATUS, CHANGED) with the status badge and the source line;
  - **Check provider again**, and no Reopen (finding 9);
  - "What changed";
  - "Add a correction", with Driver, What to change, New value, "Reason (players see this)" and the "Saving re-scores this session. N teams own …" line.

  Sessions are reached from the Calendar's event panel and from review items.
- [ ] **Step 4: Run `pnpm test src/staff` and `pnpm e2e staff-results`.** Expected: green.
- [ ] **Step 5: Commit** `feat: session results and corrections for staff`.

### Task 8: Scoring: the dry run, approval and ruleset versions

**Files:**
- Create: `src/staff/scoring.ts`, `src/routes/staff.scoring.tsx`.
- Modify: `src/game/corrections.ts` (`discardDryRun`), `src/staff/cli.ts` and `.github/workflows/staff-action.yml` (`correct-ruleset`, by decision 3), `src/server/staff.ts`, `src/audit/actions.ts`.
- Test: `src/staff/scoring.test.ts`, `src/game/corrections.test.ts`, `src/staff/cli.test.ts`, `e2e/staff-scoring.spec.ts`.

**Interfaces:**
- Consumes: `dryRunGame`, `approveRescore`, `publishCorrectionVersion`.
- Produces:
  - `dryRunSummary(db, gameId) → { tiles, rows, events, engineVersion } | null`;
  - `discardDryRun(db, now, actor, { gameId, reason })`;
  - `rulesetVersions(db, gameId)`.

- [ ] **Step 1: Write the failing tests:**
  - `dryRunSummary gives teams affected of total, events, the biggest change and leagues whose first place changes`;
  - `discardDryRun marks the dry run discarded, and approveRescore is then refused with dry_run_required`;
  - `approve twice: the second is refused with stale`;
  - `correct-ruleset parses its JSON and calls publishCorrectionVersion with the reason`;
  - e2e `run a dry run, see the tiles and biggest changes, approve it, and the audit log has both`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** The screen is the board:
  - "SCORING · DRY RUN · NOTHING HAS CHANGED YET";
  - the four tiles and BIGGEST CHANGES;
  - the approval line with the rounds it re-scores and "Prices aren't changed.";
  - **Discard** and **Approve and re-score**.

  With no dry run, the screen offers **Start a dry run** with a reason. Below it is the game's ruleset versions, read-only.
- [ ] **Step 4: Run `pnpm test src/staff src/game` and `pnpm e2e staff-scoring`.** Expected: green.
- [ ] **Step 5: Commit** `feat: the scoring dry run and approval for staff`.

### Task 9: Prices

**Files:**
- Create: `src/staff/prices.ts`, `src/routes/staff.prices.tsx`.
- Modify: `src/server/staff.ts`, `src/audit/actions.ts`.
- Test: `src/staff/prices.test.ts`, `e2e/staff-prices.spec.ts`.

**Interfaces:**
- Consumes: `upsertPrices` (source `admin`), `price_update_runs.inputs`, `priceList`.
- Produces:
  - `nextPrices(db, gameId) → { event, published, publishedAfter, rows, counts }`;
  - `setAdminPrice(db, now, actor, { gameId, eventId, assetId, price, reason })`.

- [ ] **Step 1: Write the failing tests:**
  - `nextPrices shows each asset's now, last-3 average, what its price expects, its tier and the change`;
  - `setAdminPrice on an upcoming event writes an admin price and audits asset_price.set`;
  - `setAdminPrice on an open event is refused with prices_frozen`;
  - `setAdminPrice outside $3M–$34M is refused with invalid`;
  - e2e `change one price by hand, and it shows as set by staff`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** The screen is the board's table. The heading line is "Published when the <event> became final" or "Not published yet", by decision 1. The tiers use the board's words: Much better, Better, A bit better, As expected, A bit worse, Worse, Much worse. It also shows the carry-over line and **Change one by hand**.
- [ ] **Step 4: Run `pnpm test src/staff` and `pnpm e2e staff-prices`.** Expected: green.
- [ ] **Step 5: Commit** `feat: prices for staff`.

### Task 10: The review queue

**Files:**
- Create:
  - `src/staff/review-kinds.ts`;
  - `src/staff/review.ts`;
  - `src/routes/staff.review.tsx`;
  - `src/routes/staff.review.$itemId.tsx`.
- Modify: `src/reference/review.ts` (`kind: ReviewKind`), every `openReviewItem` caller (type only), `src/server/staff.ts`, `src/audit/actions.ts`, DM 2.9.
- Test: `src/staff/review-kinds.test.ts`, `src/staff/review.test.ts`, `e2e/staff-review.spec.ts`.

**Interfaces:**
- Consumes: Task 5's `cancelEvent`, Task 6's `setAvailability`, `changeSeats` and `recordSubstitution`, Task 7's `suppressResult` and `revokeOverride`, and `advanceStatus`.
- Produces:
  - `REVIEW_KINDS: Record<string, { title(details): string; summary(details): string; evidence(details): [label, value][]; actions: ReviewAction[] }>`, with `type ReviewKind`;
  - `ReviewAction = { id; label; run?(tx, now, actor, item, reason) }`, where an action without `run` is "Go to …" and links to the screen named in `href(item)`;
  - `reviewList(db, { status })`, `reviewItem(db, id)`;
  - `resolveReviewItem(db, now, actor, { id, version, actionId, reason }) → { status }`.

- [ ] **Step 1: Write the failing tests:**
  - `every ReviewKind has a title, a summary and at least one action, the last always "Dismiss"`;
  - `resolve team_change with "Update seats from this event on" closes the seat and opens the new one, resolves the item, and audits both in one transaction`;
  - `resolve missing_driver with "Mark unavailable" sets availability and moves the session on`;
  - `resolve event_missing_from_provider with "Mark cancelled" on an event that has since locked is refused with event_locked, item still open`;
  - `two resolves at the same version: one succeeds, the other is refused with stale and writes no audit row`;
  - `a blocking item's resolution lets advanceStatus take the session to provisional`;
  - `the held line names the sessions whose scoring the open blocking items hold`;
  - e2e `resolve a team change from the queue, and it moves to Resolved with its reason`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - One `REVIEW_KINDS` entry per kind opened in `src/` (`grep -rn openReviewItem src`). The board's five use its copy and actions; the others get a plain title, their details as evidence, a "Go to …" action where a screen fixes it, and Dismiss.
  - An action's `run` and the resolve happen in one transaction, after `resolveVersioned` has claimed the item. If the action throws, the transaction rolls back and the item stays open.
  - The screen is the board: Open and Resolved tabs, the list, the detail with evidence, the held line, "Reason (saved in the audit log)", and the actions.
- [ ] **Step 4: Run `pnpm typecheck`, `pnpm test src/staff src/reference` and `pnpm e2e staff-review`.** Expected: green.
- [ ] **Step 5: Commit** `feat: the review queue`.

### Task 11: The moderation queue

**Files:**
- Create: `src/community/queue-read.ts`, `src/routes/staff.moderation.tsx`, `src/routes/staff.moderation.$itemId.tsx`.
- Modify: `src/community/moderate.ts` (the versioned claim), `src/server/staff.ts`.
- Test: `src/community/queue-read.test.ts`, `src/community/moderate.test.ts`, `e2e/staff-moderation.spec.ts`.

**Interfaces:**
- Consumes: `moderate`, `accountActions`, `resolveVersioned`.
- Produces:
  - `modQueue(db, { tab: "open" | "hidden" | "done", before? })`;
  - `modItem(db, id) → { snapshot, where, type, reports: { reason, count }[], author: { username, trustLevel, joined, posts, earlier } , version }`;
  - `moderate` input gains `version`.

- [ ] **Step 1: Write the failing tests:**
  - `modItem shows the snapshot at first report even after the post is edited`;
  - `modItem's author history counts earlier actions from mod_actions`;
  - `two moderators act on one item at its version: one acts, the other is refused with stale and no restriction is written`;
  - `"Keep it, close reports" dismisses the item and restores auto-hidden content`;
  - `the Auto-hidden tab lists open items whose content is hidden_by_flags`;
  - `a deleted author shows as deleted user`;
  - e2e `remove a reported post with a note, and the author sees the note under Actions on your account`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** The screen is the board:
  - the tabs;
  - the list (state badge, REASON · TYPE, snippet, where · reports · age);
  - "WHAT WAS POSTED · SNAPSHOT AT FIRST REPORT", REPORTS and ABOUT THE AUTHOR;
  - "Note to the author (they see this, and can appeal)";
  - two actions fitting the target, and "Keep it, close reports".

  Which two actions show is a table per target type and reason in `queue-read.ts`. For example, a spoiler thread gets "Retitle and mark as spoiler" and "Remove thread".
- [ ] **Step 4: Run `pnpm test src/community` and `pnpm e2e staff-moderation`.** Expected: green.
- [ ] **Step 5: Commit** `feat: the moderation queue screen`.

### Task 12: Users: lookup, roles, bans, trust and impersonation

**Files:**
- Create: `src/staff/users.ts`, `src/routes/staff.users.tsx`, `src/routes/staff.users.$username.tsx`.
- Modify: `src/server/staff.ts`.
- Test: `src/staff/users.test.ts`, `e2e/staff-users.spec.ts`.

**Interfaces:**
- Consumes: `setRole`, `banUser`, `unbanUser` (Task 2's signatures), `setTrustLevel`, `clearTrustLock`, `startImpersonation`, `accountActions`, `moderate` (mute, chat ban, warn).
- Produces: `findUsers(db, query)` (by username prefix, at most 20, never by email), and `userDetail(db, username)` with role, trust, restrictions, recent actions and trust history.

- [ ] **Step 1: Write the failing tests:**
  - `findUsers matches a username prefix and never an email`;
  - `a moderator's userDetail has no role, ban or impersonation actions`;
  - `a moderator calling setRole through the server function is refused with forbidden`;
  - `userDetail shows a deleted user's tombstone without a username`;
  - e2e `find a user, set their trust level with a reason, and it shows locked`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** with the boards' patterns: a search field and table, then a detail panel with a reason field and actions grouped as Account (admin only), Trust, and Restrictions. Impersonation opens the existing flow.
- [ ] **Step 4: Run `pnpm test src/staff` and `pnpm e2e staff-users`.** Expected: green.
- [ ] **Step 5: Commit** `feat: user lookup for staff`.

### Task 13: Settings and feature flags

**Files:**
- Create: `src/settings/write.ts`, `src/routes/staff.settings.tsx`.
- Modify:
  - `src/settings/defaults.ts` (`feature_flags`);
  - `src/community/session-threads.ts` and `src/server/chat-refresh.ts` (chat off);
  - `src/notifications/push.ts` (push off);
  - `src/server/staff.ts`, `src/audit/actions.ts`, DM 2.11.
- Test: `src/settings/write.test.ts`, `src/community/session-threads.test.ts`, `src/notifications/push.test.ts`, `e2e/staff-settings.spec.ts`.

**Interfaces:**
- Produces:
  - `setSetting(db, now, actor, { key, value, reason })`, which validates with `settingSchemas[key]` and audits `setting.update` with `before` and `after`;
  - `feature_flags: { chat: boolean; push: boolean }`, default both true;
  - `EDITABLE_SETTINGS`: the keys the screen edits (`feature_flags`, `poll_schedule`, `finalizer_checks`).

- [ ] **Step 1: Write the failing tests:**
  - `setSetting refuses a value its schema refuses, with invalid, nothing written`;
  - `setSetting refuses an empty poll schedule and a finalizer check of 0`;
  - `setSetting with an unchanged value writes nothing`;
  - `a key outside EDITABLE_SETTINGS is refused with forbidden`;
  - `with chat off, a session thread in its window is in discussion mode and the refresh answers 404`;
  - `with push off, push_fanout sends nothing and in-app notifications are still written`;
  - e2e `turn chat off with a reason, and the audit log shows On → Off with it`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** The screen is the board:
  - "Admins only. Every change goes in the audit log.";
  - FEATURES with Switches for chat and push, and notification emails and ads locked with the board's reasons;
  - FREE-TIER USAGE, empty until Task 14;
  - RESULTS PIPELINE: "First check (min)", "Then (min)", "Give up and alert after (hours)" and "Re-check after the race (hours)", with a reason and **Save settings**.
- [ ] **Step 4: Run `pnpm test src/settings src/community src/notifications` and `pnpm e2e staff-settings`.** Expected: green.
- [ ] **Step 5: Commit** `feat: settings and feature flags for staff`.

### Task 14: Usage meters

By decision 2. This is written for the recommended answer. Alternative A drops the workflow and the table, and keeps the email meter and the dashboard links.

**Files:**
- Create:
  - `src/db/schema/usage.ts` and one migration;
  - `src/staff/usage.ts`;
  - `scripts/usage-snapshot.ts`;
  - `.github/workflows/usage-snapshot.yml`.
- Modify: `src/routes/staff.settings.tsx`, `src/staff/review-kinds.ts` (`usage_high`), DM 2.11 and HLD §11.4.
- Test: `src/staff/usage.test.ts`, `scripts/usage-snapshot.test.ts`.

**Interfaces:**
- Produces:
  - table `usage_snapshots (id, taken_at, neon_compute_hours, neon_transfer_gb, vercel_cpu_hours, limits jsonb)`;
  - `recordUsage(db, now, snapshot)`, which inserts and opens a `usage_high` warning for each meter at 70% or more, deduped per meter per month;
  - `usageMeters(db, now) → { label, value, pct, note, warn }[]`.

- [ ] **Step 1: Write the failing tests:**
  - `recordUsage at 74% compute opens one usage_high warning, and a second snapshot the same month opens none`;
  - `usageMeters shows Fine under 70% and the board's warning over it`;
  - `the email meter counts today's sent and queued account emails against email_caps`;
  - `usage-snapshot maps Neon's and Vercel's answers (stored fixtures) to a snapshot, and never prints a key`.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The workflow runs at 05:00 UTC in the `staging` environment and uses the secrets by name only.
  - The script reads the two APIs, and on any error writes nothing and fails the run, so a missing token shows as a red run, not a zero meter.
  - The meters show "No reading yet" before the first snapshot.
- [ ] **Step 4: Run `pnpm test src/staff scripts`.** Expected: green.
- [ ] **Step 5: Commit** `feat: free-tier usage meters`.

### Task 15: The exit: every board, staging and a staff walk-through

**Files:**
- Create: `e2e/staff-exit.spec.ts`, `src/staff/staff-writes.test.ts`.
- Modify: `docs/design/04-implementation-plan.md` (M8's result), `docs/design/03-ui-brief.md` (what was built differently), DM sections touched.

- [ ] **Step 1: Write the roadmap's first key test,** `src/staff/staff-writes.test.ts`. It's table-driven over every staff write that M8's server functions expose (`src/server/staff.ts`'s exports, listed in the test, with a check that the list matches the module's keys). For each, called once with valid input:
  - `it writes exactly one audit row per change, with a non-blank reason and the request id`;
  - `with a blank reason it is refused with reason_required and writes nothing`.
- [ ] **Step 2: Write the exit e2e,** at 1440 and at phone size, on the replay-mode build:
  - an admin unlocks with a code;
  - they move a lock and see it in the audit log;
  - they resolve a review item while a second admin's resolve of it is refused;
  - they correct a result;
  - they run and approve a dry run;
  - they change a setting;
  - a moderator acts on a report and is refused the calendar;
  - axe finds nothing on every staff page.
- [ ] **Step 3: Run the whole suite:** `pnpm test`, `pnpm e2e`, lint, typecheck and build. Expected: green.
- [ ] **Step 4: With your OK, deploy staging** (`gh workflow run deploy-staging.yml --ref main -f import_2026=false`). Expected: the migrations apply and the site serves `/staff` to your account only.
- [ ] **Step 5: With your OK, the staff walk-through on staging.** Using your admin account, which you unlock with your own code, you or I move a lock on a future event and move it back, and change and restore one setting. Both have reasons, and both show in the audit log. Nothing else on staging is changed.
- [ ] **Step 6: Record M8's result** in the roadmap, with what's carried to M9. Commit `docs: M8's result`.
