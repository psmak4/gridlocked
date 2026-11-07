# M5 Identity and Accounts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** people can sign up safely, and staff accounts are secured (roadmap M5, epic psmak4/gridlocked#6).

**Exit:**
- every DM Part 6 scenario row has a passing test, or a named later milestone (decision 4);
- sign-up works end to end in staging.

**Architecture:**
- **Better Auth runs self-hosted inside the app,** on our own Neon database, through one catch-all route, `/api/auth/$`. It owns the sign-in tables only (DM 6.1), renamed to ours. Everything else about a person lives in `profiles` and the tables beside it (DM 6.2).
- **A new module, `src/identity/`, holds the rules:** usernames, consent, roles, trust levels, the email outbox, export and deletion. Only `src/identity/auth.ts` and `src/server/` may import `better-auth`, so an upgrade stays in one place (a lint rule keeps it there).
- **M5 is the first milestone where the website touches the database.** Requests get a database through `src/server/db.ts`, and a logged-out page never opens it (HLD §11.4).
- **Email goes through one table.** A request writes an `email_outbox` row, and sends it there and then if the allowance has room. Anything left over waits for the `email_flush` job on the existing scheduler tick.
- **Every outside service sits behind something a test can replace.** Resend is a port, Turnstile and Discord are reached by `fetch`, so **Tasks 1–14 need no cloud account at all.** Only Task 15 does.
- **Export and deletion read one registry of personal data,** and a test fails if a table points at `users` without being in it. That's how M7's posts and chat can't be forgotten.

**Tech Stack:** TanStack Start, Better Auth 1.7.18 (with `@better-auth/drizzle-adapter`), Drizzle, Postgres (PGlite in tests, Neon in staging), Zod, shadcn/ui on Base UI 1.9.0, Vitest, Playwright, Resend (REST API, no SDK), Cloudflare Turnstile, the Nitro `vercel` preset.

**Spec:**
- [02-data-model.md](../design/02-data-model.md) Part 6, and 5.1, 5.9 (`filter_rules`) and 5.11 (`email_outbox`);
- [01-high-level-design.md](../design/01-high-level-design.md) §7.4, §9, §10, §11.4 and §11.5;
- [03-ui-brief.md](../design/03-ui-brief.md) wave 4, and its [canvas](https://claude.ai/artifact/V1zQ2UffcabkH67GNgJiSS) for the exact copy;
- [04-implementation-plan.md](../design/04-implementation-plan.md) M5;
- [spikes/framework-hosting.md](../spikes/framework-hosting.md), for the response rules and the `spike/framework-start` branch, which has a working Better Auth route;
- the M4 ledger's item carried to M5: an empty `diff_summary` on the late-change path (Task 14).

## What checking the spec turned up
I read Better Auth 1.7.10's source (the version on the spike branch) and the providers' docs. These change what the design says, and the tasks below follow them.

1. **The design's "trusted providers" for Discord would let an account be stolen.** In Better Auth, a trusted provider links to a matching account **even when its email is unverified.** So anyone could set an unverified Discord email to a victim's address and sign in as them. `discord` must **not** be in `trustedProviders`. Left out, it links only if Discord says the email is verified and our own account's email is verified too (`requireLocalEmailVerified`, on by default). DM 6.11's row gets corrected in Task 5.
2. **Turnstile doesn't cover magic links by default.** The plugin's default list is `/sign-up/email`, `/sign-in/email` and `/request-password-reset`. Unprotected, a script could spend the whole 100-a-day allowance on one form.
3. **The two-factor plugin only challenges password sign-in.** A staff member using a magic link or Discord would skip it (decision 5).
4. **`result_overrides.created_by` holds a placeholder id on staging.** `STAFF_PLACEHOLDER_USER_ID`, the all-zero uuid, is in real rows (the Mexico City override). Adding the foreign key fails unless a `users` row has that id (Task 1).
5. **Resend sends only to your own account address until a domain is verified** (decision 2).
6. **The website can't wake the scheduler quickly.** Publishing the due-times file needs Object Storage keys, which only the Neon Function has. So a job queued from a web request waits for the safety tick, at most 6 hours. That's fine for a queued email or an export, and it's why a normal email is sent inside the request.
7. **The roadmap's "preview deploys" and "prebuilt from CI" pull in different directions,** and the M5 epic leaves Vercel off its approval list (decision 1).

## Decisions (approved 7 Nov 2026)
These five change what gets built. You approved all five recommendations, and the alternatives stay here for the record. This settles the design only: every cloud account in [What each task needs from you](#what-each-task-needs-from-you) is still a separate approval.

1. **What is the staging website?** Discord needs its redirect URL registered, and Turnstile lists hostnames with no wildcards. Vercel's Standard Protection covers everything except production domains. So sign-in needs one fixed public address.
   - **Approved: one Vercel project, `gridlocked-staging`, deployed to its fixed `gridlocked-staging.vercel.app` address.** The existing manual **Deploy staging** workflow builds it in CI and uploads it prebuilt, right after the migrations, so code and schema always match. It deploys from `main` only. The Vercel GitHub app isn't needed. If that name is taken, any fixed name works.
   - **Not chosen: the roadmap's GitHub app, with a preview per PR.** You'd see each PR running. But preview addresses change, so Discord, Turnstile and email links only work on a stable alias anyway, and every preview shares a staging database that's only migrated from `main`.
2. **Real email in staging, with no domain of our own.**
   - **Approved: no domain in M5.** Staging sends from `onboarding@resend.dev`, which reaches only your Resend account address. That's enough to prove the path. Tests use Resend's `delivered@resend.dev` address. The domain arrives with production in M9, which matches HLD §13.1 (no purchase before the trademark check) and the free-plans rule.
   - **Not chosen: buy the primary domain now.** Staging could email anyone, but it costs money ahead of the trademark check.
3. **Age, terms and a username for people who don't use the email form.** Wave 4's "Choose a way in" only has a footer line ("By continuing you agree…"). It has no username step for Discord or magic link, and it leaves out the community rules.
   - **Approved: a short "Finish signing up" screen after a first Discord or magic-link sign-in,** with the same two checkboxes and the username field as the email form. Until it's done, the account can do nothing. Each person leaves an explicit, dated record (DM 6.2, 6.8). An account that never finishes is removed after 7 days. That's a hard delete, because nothing about it was ever accepted or kept. This is a new screen, built from the email form's parts, and the footer line gets reworded.
   - **Not chosen: treat the footer line as acceptance.** One less screen, but weaker evidence for your lawyer, and Discord and magic-link people still need a username step.
4. **Part 6 rows that depend on things later milestones build.** There's no chat until M7 and no staff screens until M8, so a few of the epic's tests can't be real yet. The roadmap's "an export including archived chat" is one.
   - **Approved: M5 builds the rule and the guard, and names where the row finishes** ([the table at the end](#scenario-coverage-dm-611-and-the-roadmaps-key-tests)). The registry test forces M7 to add its tables to export and deletion. "An export including archived chat" moves to M7's key tests.
   - **Not chosen: add stub chat tables now for the test.** The test would pass, but it would prove nothing about the real chat tables.
5. **Staff two-step sign-in.** DM 6.4 proposed it as required, and this decision makes it so. Because of finding 3, it also needed a design.
   - **Approved: staff tools ask for a TOTP code once per session, however the person signed in.** Password sign-in also keeps the plugin's normal challenge. A session that hasn't passed stays an ordinary user session.
   - **Not chosen: staff may only sign in with a password and TOTP,** with magic link and Discord refused for staff roles. It's simpler to explain, but an admin who signed up through Discord would first need a password.

**My calls (lower stakes; each is written into the DM when its task lands):**
- **Better Auth 1.7.18,** pinned exactly (the latest release, 8 versions after the spike). Behaviour I read in 1.7.10 is pinned by tests in the owning tasks, so a difference shows up as a failing test.
- **Sign-up can be closed by a setting.** `SIGN_UP_ALLOWED_EMAILS`, when set, refuses new accounts for any other address, on every sign-in method. Staging runs with it set, so strangers can't put personal data in a test database under placeholder terms. M9's closed beta can use the same switch.
- **Legal documents are placeholders until M9.** Task 7 seeds version `draft-1` of the terms, privacy policy and community rules, on pages that say they're drafts. Your lawyer's text arrives in M9 as a new version with `requires_reacceptance`.
- **A password is at least 10 characters,** and a username is 3–20 letters, numbers or underscores, as wave 4 shows. Non-ASCII letters are refused, which also rules out look-alike characters.
- **Magic links last 15 minutes,** up from Better Auth's 5, since a queued one must survive a short wait. A queued link that's already expired is dropped, not sent, so it doesn't spend the allowance. Its tokens are hashed at rest (`storeToken: "hashed"`).
- **Email templates are plain functions** returning subject, text and HTML. HLD §11.5 suggests React email templates, but the Neon Function also renders them, and five short emails don't need a dependency.
- **Email is capped by month as well as by day:** 100 a day and 3,000 a month. The last 20 of each day are kept for magic links, resets and deletion links ("Magic links and resets go first", DM 5.11).
- **`email_outbox` gains `sent_at`, `expires_at`, `last_error` and the status `expired`,** and two templates: `email_change_notice` and `delete_confirm`. A finished row keeps no address and no link: `to_email` is nulled and `payload` emptied, so the table isn't a list of everyone's email or of live sign-in links.
- **`privacy_requests` gains `export_url`, `confirm_token_hash` and `confirm_expires_at`.** The job signs a 7-day download link, which is S3's longest. The website has no Object Storage keys, so it can't sign one itself. If Neon refuses 7 days, Task 10 signs the longest it allows and the settings page says so.
- **Banning, role changes and trust changes write `users` directly,** in one transaction with the audit row, instead of calling the admin plugin's endpoints. Those endpoints can't share a transaction with the audit. All `/admin/*` HTTP paths are in `disabledPaths`, except the two for impersonation.
- **Impersonation audits first, then acts,** because only the plugin can mint that session. A failed attempt leaves an audit row saying so, which is better than an unrecorded success.
- **Impersonated sessions are read-only by default.** A `before` hook refuses every non-GET auth path except sign-out and stop-impersonating, and our server functions use `requireWritable`. That's DM 6.11's "read-only" and it's stricter than 6.4's list.
- **The first admin comes from `pnpm staff set-role`,** through the Staff action workflow. You sign up on staging first, then run it. It takes a username, never an email, because this repo's Actions logs are public.
- **Moving a username's capital letters isn't a rename:** no history row, and the 30-day limit doesn't apply.
- **Trust thresholds are my starting numbers,** in `settings`. HLD §7.4 gives TL1 as an example and leaves the others open: TL1 is 3 days and 10 posts, TL2 is 15 days, 50 posts and 25 reputation, TL3 is 60 days, 200 posts and 200 reputation.
- **`feature_flags` and `consent_records` wait for M8.** Nothing in M5 reads them.

## What each task needs from you
**Nothing in Tasks 1–14 needs an account, a key or a staging write.** They're built and tested against PGlite, a fake email sender, stubbed `fetch` and Playwright on a local build. Task 15 waits on all four approvals, and can take them one at a time:

| Approval | What you create and enter (I never see these) | Where it goes | What it unlocks in Task 15 |
|---|---|---|---|
| **Vercel project, Hobby** | Project `gridlocked-staging`; an access token; a secret from `openssl rand -base64 32`; the staging pooled `DATABASE_URL` | Token: GitHub `staging` secret `VERCEL_TOKEN`. Org and project ids: GitHub `staging` variables. Secret and URL: Vercel env `BETTER_AUTH_SECRET`, `DATABASE_URL` | The site itself. Needed first |
| **Resend account, Free** | An API key | GitHub `staging` secret `RESEND_API_KEY_STAGING` (for the tick), Vercel env `RESEND_API_KEY` | Real email: verification, magic links, resets |
| **Cloudflare Turnstile site key, free** | A widget for `gridlocked-staging.vercel.app` | Site key: GitHub `staging` variable `VITE_TURNSTILE_SITE_KEY`. Secret: Vercel env `TURNSTILE_SECRET_KEY` | The real bot check |
| **Discord application** | An app with the redirect URL `https://gridlocked-staging.vercel.app/api/auth/callback/discord` | Vercel env `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | "Continue with Discord" (the button is hidden without them) |

- **Free plans:** the Resend, Turnstile and Vercel pages I read don't say whether sign-up asks for a card. If any does, stop there and tell me.
- **The site writes to staging.** Sign-ups and sessions write to `gridlocked-staging` directly, not through a workflow. Saying yes to Task 15 approves that, and `SIGN_UP_ALLOWED_EMAILS` limits who can sign up.
- **One more cloud resource:** Task 10 adds an `exports` bucket to `neon.ts`, on the existing staging project. The next deploy after that merges creates it. That's a fifth thing to approve, though it needs no account.
- **Each staging deploy still waits for your OK,** and never runs during a race weekend (rounds 20–23 run to 6 Dec).
- **M4's deploys carry M5's migrations.** If M4 needs a staging deploy once M5 work has merged, that deploy applies M5's tables and foreign keys too. Nothing in the running season reads them, and Task 2's check clears the one risk. The site itself stays off until Task 15.

## Global Constraints
- **No direct time.** Every function takes `now: Date` from its caller (HLD decision 20). Entry points resolve it once with `resolveClock`. Better Auth reads its own clock for its own tables, and nothing else does.
- **Better Auth is confined** to `src/identity/auth.ts`, `src/identity/auth-client.ts` and `src/server/`.
- **Its built-in `deleteUser` stays disabled.** Deletion is ours (DM 6.0, 6.7).
- **Every response from `/api/auth/*` and every signed-in page sends `Cache-Control: private, no-store`,** including redirects. `advanced.useSecureCookies: true` stays on. Server-rendered controls stay disabled until hydrated (HLD §11.4).
- **Logged-out pages never open the database or set a cookie.**
- **Every staff write and security event is audited** with a reason where DM 6.6 needs one. Personal fields (email, IP) are stored as `"[redacted]"`.
- **Nothing personal in logs.** The Actions logs are public, so `pnpm staff` prints usernames and ids only. Server errors never include an address or a link.
- **Secrets:** none in a file, a commit, a log or a Claude message. `.env.example` lists names only. `neon.ts` reads `process.env` and declares nothing when it's unset, so a deploy before the Resend approval still works.
- **UI uses design-system tokens only** (the default Tailwind palette is removed), with the wave 4 copy and targets of at least 44 px.
- **Foreign keys to `users` are `ON DELETE RESTRICT`,** except Better Auth's own tables, which cascade (DM 0.7).
- **Migrations:** schema in `src/db/schema/identity.ts`, then `pnpm db:generate`. Triggers and seeds go in custom migrations `identity_rules`, `identity_rules_2` and so on, and `pnpm db:drift` stays clean.
- **New dependencies are pinned exactly** and listed in the task that adds them: `better-auth`, `@better-auth/drizzle-adapter`, `@base-ui/react`, the shadcn helpers, `@aws-sdk/s3-request-presigner`.
- **Workflow:** one branch `m5/<issue>-<slug>` and one PR per task, closing its issue. CI must be green before merge. No auto-merge and no force-push.

## Review Focus
1. **A bot asks for magic links for one address, or for thousands.** Expected: Turnstile and a per-address limit stop it, a repeat while one is queued replaces that row and adds none, and the allowance isn't spent. *Pinned in Tasks 4 and 5.*
2. **The email queue holds working sign-in links.** Expected: once a row is sent, failed or expired, it has no address and no link, and a link past its expiry is never sent. *Pinned in Task 4.*
3. **A logged-out visitor opens the home page, with or without a stale cookie.** Expected: no cookie set and no database opened for the first, one session lookup for the second, and a cacheable page in both cases. *Pinned in Task 3.*
4. **Someone returns after deleting their account.** Expected: `deleted-…@deleted.invalid` can't sign in by any method, Discord makes a brand-new account with no tie to the tombstone, the old email can sign up again, and the old username stays held for 90 days. *Pinned in Task 10.*
5. **An account is deleted while something else is running.** Expected: a team deleted just before a lock is not locked, an export job for a deleted user stops and leaves no file, and the only admin can't delete or demote themself. *Pinned in Tasks 8 and 10.*

---

## Tasks at a glance
| # | Task | Size | Needs first |
|---|---|---|---|
| 1 | Identity tables and the system user | M | |
| 2 | Every user column points at `users` | M | 1 |
| 3 | Better Auth on the site: email and password | M | 1 |
| 4 | The email outbox and its caps | M | 1, 3 |
| 5 | Magic link, verification, email change, Discord and Turnstile | M | 3, 4 |
| 6 | Usernames | M | 3 |
| 7 | Consent and the profile | M | 3, 6 |
| 8 | Roles, staff two-step, bans and impersonation | M | 2, 3 |
| 9 | Trust levels and the daily identity job | S | 4, 7 |
| 10 | Data export and account deletion | M | 2, 4, 7, 9 |
| 11 | shadcn/ui on Base UI, and the first components | S | |
| 12 | Sign-up and onboarding screens | M | 5, 6, 7, 11 |
| 13 | Profile and settings screens | M | 8, 9, 10, 12 |
| 14 | The empty `diff_summary` | S | |
| 15 | Staging, and the exit | M | everything, and **the four approvals** |

Tasks 11 and 14 can start at any time, and they touch nothing the others do. Once Task 3 is in, Task 4 can run alongside Task 6 or Task 8. Tasks 5, 6, 7 and 8 all edit `src/identity/auth.ts`, so they run one at a time. Task 2 edits helpers that M4's exit task #127 also uses, so whichever lands second rebases.

### Task 1: Identity tables and the system user

**Files:**
- Create: `src/db/schema/identity.ts`, `src/identity/system.ts`, `src/identity/system.test.ts`, `src/db/identity.test.ts`, `tests/helpers/users.ts`, migration `identity_rules`.
- Modify: `src/db/schema/index.ts`, `vitest.config.mts` (`src/identity/**` joins `dbTests`), `src/staff/results.ts`, `src/game/cancellations.ts`, `tests/helpers/replay-2026.ts`, DM 6.1, 6.2 and 5.11.

**Interfaces:**
- Produces:
  - Tables, in Drizzle with camelCase keys and snake_case columns:
    - `users`: the DM 6.1 columns, plus the plugins' `two_factor_enabled`. `id` is `uuid`. A unique index on `lower(username)`.
    - `auth_sessions`: DM 6.1, plus our `staff_verified_at` (decision 5).
    - `auth_accounts`, `auth_verifications`, `auth_rate_limits`, as Better Auth's core and admin schemas say.
    - `auth_two_factors`: `secret`, `backup_codes`, `user_id`, plus the plugin's `verified`, `failed_verification_count` and `locked_until`, which DM 6.1 doesn't list.
    - `profiles` (DM 6.2), `username_history`, `trust_level_changes`, `legal_documents`, `legal_acceptances`, `privacy_requests` (DM 6.7, with the added columns), `filter_rules` (DM 5.9), `email_outbox` (DM 5.11, with the added columns).
  - `SYSTEM_USER_ID = "00000000-0000-0000-0000-000000000000"` in `src/identity/system.ts`. It replaces `STAFF_PLACEHOLDER_USER_ID`, so existing rows point at a real row.
  - Test helper: `seedUser(db, input?: { id?: string; email?: string; username?: string; role?: Role; emailVerified?: boolean }): Promise<string>`, which writes a `users` row and a `profiles` row.
- `identity_rules`:
  - the system user: role `system`, email `system@gridlocked.invalid`, name `system`, no `auth_accounts` rows, and a `profiles` row;
  - a trigger refusing any `auth_accounts` insert for a role `system` user;
  - seeds for `filter_rules` scope `usernames`: `admin`, `moderator`, `gridlocked`, `system`, `support`, and the regex patterns for `f1`, `formula1`, `formula_1`, `fia` and `official`.

- [ ] **Step 1: Write the failing tests** (`identity.test.ts`):
  - `the system user exists with role system and no sign-in accounts`;
  - `an auth account for the system user is refused`;
  - `usernames are unique whatever their case`;
  - `trust_level outside 0 to 3 is refused`;
  - `a filter rule's scope, match type and effect are checked`;
  - `email_outbox allows one queued row per address and template` (a partial unique index on `(lower(to_email), template) WHERE status = 'queued'`).
- [ ] **Step 2:** Run `pnpm test src/db/identity.test.ts src/identity`. Expected: FAIL.
- [ ] **Step 3:** Define the tables, run `pnpm db:generate`, and write `identity_rules`. Add the DM 6.10 indexes and the outbox index `(status, send_after)`.
- [ ] **Step 4:** Move the constant to `SYSTEM_USER_ID` and update its 3 users.
- [ ] **Step 5:** Run `pnpm test && pnpm db:drift`. Expected: PASS and no drift.
- [ ] **Step 6:** Update the DM. Commit: `feat: the identity tables and the system user`.

### Task 2: Every user column points at `users`

**Files:**
- Modify: `src/db/schema/game.ts`, `leagues.ts`, `results.ts`, `audit.ts`, `settings.ts`, `src/audit/log.ts`, `src/audit/log.test.ts`, `src/replay/game-script.ts`, the 18 test files that invent user ids, DM 3.6, 4.5 and 6.6.

**Interfaces:**
- Consumes: `seedUser`, `SYSTEM_USER_ID` (Task 1).
- Produces:
  - `ON DELETE RESTRICT` foreign keys on the 9 columns that say "FK to users added in M5": `teams.user_id`, `leagues.owner_user_id`, `game_session_exceptions.decided_by`, `result_overrides.created_by` and `revoked_by`, `review_items.resolved_by`, `audit_log.actor_user_id` and `impersonating_user_id`, `settings.updated_by`.
  - `AuditEntry` gains `actorUserId?: string | null` and `impersonatingUserId?: string | null`.
  - `writeAudit` runs `before` and `after` through `redactPersonal(value)`, which replaces the keys `email`, `ip`, `ipAddress`, `userAgent` and `name`, at any depth, with `"[redacted]"`.

- [ ] **Step 1: Write the failing tests.** In `src/db/identity.test.ts`:
  - `a team needs a real user`;
  - `a user with a team can't be deleted`;
  - one test per remaining column, table-driven;
  - `the override written with the system user id is accepted`.

  In `log.test.ts`: `an email inside before or after is stored redacted, at any depth`; `an audit row can name its user and the user it impersonated`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Add the references and run `pnpm db:generate`. Remove the "added in M5" comments. Implement `redactPersonal`.
- [ ] **Step 4:** Fix the tests that invent ids: `seedUser` in each `beforeEach` or setup, and `SYSTEM_USER_ID` for `createdBy: newId()`. Scripted teams in `src/replay/game-script.ts` get users in the same step that makes them. Don't change an assertion: if one breaks, stop and report it.
- [ ] **Step 5:** Run `pnpm test && pnpm db:drift`. Expected: all pass, with the season replays unchanged.
- [ ] **Step 6: Before merging,** with your OK, count orphans on `gridlocked-staging` in a read-only query: the 9 columns holding anything except the zero uuid. Expected: 0. Once this merges, the next staging deploy of any kind applies it. If the count isn't 0, stop and report it: M4's live run mustn't fail on a foreign key.
- [ ] **Step 7:** Update the DM. Commit: `feat: foreign keys to users`.

### Task 3: Better Auth on the site: email and password

**Files:**
- Create:
  - `src/identity/auth.ts`, `src/identity/auth.test.ts`, `src/identity/auth-client.ts`, `src/identity/env.ts`, `src/identity/env.test.ts`, `src/identity/viewer.ts`, `src/identity/viewer.test.ts`;
  - `src/server/db.ts`, `src/server/local-db.ts`, `src/server/session.ts`, `src/server/no-store.ts`, `src/server/no-store.test.ts`, `src/routes/api/auth.$.ts`;
  - `.env.example`.
- Modify: `package.json`, `eslint.config.mjs`, `tests/lint/` (a fixture for the new rule), `.github/workflows/ci.yml`, `playwright.config.ts`, `src/settings/defaults.ts`, DM 6.0.

**Interfaces:**
- Consumes: the Task 1 tables; `newId()`; `createDb(url)`; `resolveClock`. The working wiring on `spike/framework-start` (`src/spike/auth.ts`, `src/spike/db.ts`, `src/routes/api/auth.$.ts`) is the starting point.
- Produces:
  - `parseAuthEnv(env): AuthEnv`, Zod-validated. `BETTER_AUTH_SECRET` and `BETTER_AUTH_URL` are required outside local mode. `signUpAllowlist: string[] | null` comes from `SIGN_UP_ALLOWED_EMAILS`.
  - `createAuth(db: Db, deps: AuthDeps)`, where `AuthDeps = { env: AuthEnv; now: () => Date }` (Task 5 adds `sender`). Configuration:
    - `drizzleAdapter(db, { provider: "pg", schema, transaction: true })`, with `modelName` set for `users`, `authSessions`, `authAccounts`, `authVerifications`, `authTwoFactors`, `authRateLimits`;
    - `advanced: { useSecureCookies: true, database: { generateId: () => newId() }, ipAddress: { ipAddressHeaders: ["x-vercel-forwarded-for", "x-forwarded-for"] } }`;
    - `emailAndPassword: { enabled: true, minPasswordLength: 10, revokeSessionsOnPasswordReset: true }`;
    - `rateLimit: { enabled: true, storage: "database", modelName: "authRateLimits" }`;
    - `user.deleteUser.enabled: false`;
    - plugins so far: `admin`, `tanstackStartCookies()`, which must stay last;
    - `disabledPaths`: every `/admin/*` path except `/admin/impersonate-user` and `/admin/stop-impersonating`;
    - `databaseHooks.user.create.before`: refuses an address outside `signUpAllowlist`, and any `.invalid` address;
    - `databaseHooks.user.create.after`: `ensureProfile`.
  - `ensureProfile(db, now, userId): Promise<void>`, idempotent, with a random `avatar_seed`, so a lost hook repairs itself on the next session read.
  - `withDb<T>(fn: (db: Db) => Promise<T>): Promise<T>` in `src/server/db.ts`, one shared handle per server instance. With `VITE_LOCAL_DB=1` it dynamically imports a migrated PGlite from `local-db.ts`, so the deployed bundle never contains it.
  - `withNoStore(response: Response): Response`, which copies a response if its headers are immutable (a redirect's are).
  - `Viewer = { userId; role; username; displayUsername; emailVerified; twoFactorEnabled; sessionId; impersonatedBy: string | null; staffVerifiedAt: Date | null; profile: Profile; complete: boolean }`.
  - `getViewer(request): Promise<Viewer | null>` in `src/server/session.ts`. With no session cookie it returns null without touching the database. Otherwise it reads the session, then `ensureProfile`, then `touchViewer`.
  - `touchViewer(db, now, viewer)`: writes `last_seen_at` at most every 15 minutes, and bumps `days_visited` on the first request of a UTC day.
  - Guards: `requireViewer(v)`, `requireComplete(v)`, `requireWritable(v)` (complete and not impersonating), `canPost(v)` (verified, active, not impersonating), each throwing `IdentityError` with a `code`.
  - `consumeRateLimit(db, now, key, { windowSeconds, max }): Promise<boolean>` over `auth_rate_limits`, the limit M4 promised for league join codes. M6 calls it from the join server function.

- [ ] **Step 1: Write the failing tests.** `auth.test.ts`, each through `auth.handler(new Request(...))` on PGlite:
  - `sign-up writes a uuidv7 user and a profile`: the first run of uuid ids through Better Auth, since the spike used text;
  - `the session cookie is Secure, HttpOnly and SameSite=Lax` (ported from the spike);
  - `a password under 10 characters is refused`;
  - `sign-in with the right password works, and with the wrong one doesn't`;
  - `the built-in delete-user path is 404`;
  - `an admin path other than impersonation is 404 over HTTP`;
  - `an address outside the allowlist can't sign up`;
  - `a .invalid address can't sign up`;
  - `repeated bad sign-ins hit the database-backed rate limit`.

  `viewer.test.ts`:
  - `no cookie means no viewer and no database call` (a `db()` spy);
  - `a stale cookie means one lookup and no viewer`;
  - `a lost profile is repaired on the next read`;
  - `last_seen_at isn't written twice in 15 minutes`;
  - `days_visited rises once per UTC day`;
  - `consumeRateLimit refuses past the max and allows again after the window`.

  `no-store.test.ts`: `a 200, a 302 with immutable headers, and an error all come back private, no-store`.
- [ ] **Step 2:** Run `pnpm test src/identity src/server`. Expected: FAIL.
- [ ] **Step 3:** Add the dependencies, pinned. Implement `env`, `auth`, `db`, `session`, `viewer`, `no-store` and the route. Add the lint rule confining `better-auth`, with a fixture test.
- [ ] **Step 4:** Add a Playwright spec, `e2e/auth-api.spec.ts`:
  - `a logged-out home page sets no cookie and stays cacheable`;
  - `the auth route answers private, no-store`.

  Set `VITE_LOCAL_DB=1` on CI's build step, and in `playwright.config.ts`.
- [ ] **Step 5:** Run `pnpm test`, `pnpm lint`, `pnpm typecheck`, then `pnpm e2e`. Expected: PASS. Run `pnpm build` without the flag and check `.output/server` has no `pglite`.
- [ ] **Step 6:** Update DM 6.0 with the version and what was re-checked. Commit: `feat: Better Auth on the site`.

### Task 4: The email outbox and its caps

**Files:**
- Create: `src/identity/email/outbox.ts`, `outbox.test.ts`, `templates.ts`, `templates.test.ts`, `sender.ts`, `resend.ts`, `resend.test.ts`, all under `src/identity/email/`.
- Modify: `src/jobs/kinds.ts`, `src/jobs/functions/tick.ts`, `src/settings/defaults.ts`, `neon.ts`, `.github/workflows/deploy-staging.yml`, DM 5.11, HLD §10.

**Interfaces:**
- Consumes: `enqueue`; `openReviewItem`; `getSetting`; `consumeRateLimit` (Task 3).
- Produces:
  - `interface EmailSender { send(m: { idempotencyKey: string; to: string; subject: string; text: string; html: string }): Promise<{ id: string }> }`, in `sender.ts`, with `class EmailRejectedError` (the address is bad: don't retry) and `class EmailCapError` (Resend says we're over quota).
  - `createResendSender({ apiKey, from, fetch }): EmailSender`: `POST https://api.resend.com/emails`, with `Idempotency-Key` set to the outbox id, so a crash between send and update can't send twice.
  - `renderEmail(template, payload): { subject; text; html }`. Every email ends with the "unofficial, not affiliated" line.
  - Setting `email_caps: { perDay: 100, perMonth: 3000, reservedForUrgent: 20, alertAt: 0.8 }`.
  - `URGENT_TEMPLATES = ["magic_link", "password_reset", "delete_confirm"]`.
  - `queueEmail(db, now, { to, template, payload, expiresAt? }, sender: EmailSender | null): Promise<{ status: "sent" | "queued" | "failed" | "limited" }>`. Better Auth's own limits go by IP, so it first checks 3 emails per address and template in 10 minutes, with `consumeRateLimit` on a hash of the address. Past that it writes nothing and returns `limited`, which no caller shows, so a stranger can't tell. It then upserts the queued row, and sends at once if allowed. Over the cap, or on a passing failure, the row stays `queued` with `send_after`, and an `email_flush` job is queued for that time. Allowance checks take an advisory lock, so two requests can't both take the last place.
  - `flushEmail(db, now, sender, { limit = 50 }): Promise<{ sent: number; expired: number; failed: number; left: number }>`: urgent first, then oldest; skips rows past `expires_at`, marking them `expired`.
  - `emailAllowance(db, now): Promise<{ usedToday: number; usedThisMonth: number; busy: boolean }>`. `busy` drives "It might take a while today".
  - Job kind `email_flush`, key `email_flush:<yyyy-mm-ddThh>`.
  - Review item kind `email_cap_near`, opened once a day at `alertAt`.
  - `neon.ts`: `tick` declares `env` only when `RESEND_API_KEY` and `EMAIL_FROM` are set. With no sender, the handler leaves rows queued and logs a count.

- [ ] **Step 1: Write the failing tests** (`outbox.test.ts`, with a fake sender and fixed dates):
  - `a normal email is sent inside the call`;
  - `the 81st verification email of the day stays queued`, and `a magic link at the same moment still goes`;
  - `the 101st of any kind stays queued until the next UTC day`;
  - `the month's cap holds when the day has room`;
  - `the allowance counts in UTC`;
  - `urgent rows leave first`;
  - `asking again while queued replaces the row and spends nothing`;
  - `a fourth link to one address inside 10 minutes isn't sent, and spends nothing`;
  - `the limit's key doesn't hold the address`;
  - `two calls at once can't both take the last place`;
  - `a link past its expiry is marked expired, not sent`;
  - `a rejected address is failed and not retried`;
  - `a passing failure stays queued`;
  - `Resend's quota error stops the batch until tomorrow`;
  - `a finished row keeps no address and no link`, for `sent`, `failed` and `expired`;
  - `the 80% review item opens once a day`;
  - `the flush job with no sender leaves rows queued`;
  - `a flush run twice sends once`.

  `resend.test.ts`, with a stubbed `fetch`: the request's URL, headers and body; `a 422 is EmailRejectedError`; `a 429 quota error is EmailCapError`; `a 500 throws an ordinary error`; `no address or link appears in an error message`.

  `templates.test.ts`: `every template renders, carries its link, and ends with the disclaimer`.
- [ ] **Step 2:** Run `pnpm test src/identity/email`. Expected: FAIL.
- [ ] **Step 3:** Implement. Add `email_flush` to `JOB_KINDS` and the tick's handlers.
- [ ] **Step 4:** Update `neon.ts` and pass `RESEND_API_KEY` and `EMAIL_FROM` into the deploy step from the `staging` environment. Run `pnpm test`, and `pnpm exec tsc --noEmit`. Expected: PASS.
- [ ] **Step 5:** Update DM 5.11 and HLD §10. Commit: `feat: the email outbox and its daily cap`.

### Task 5: Magic link, verification, email change, Discord and Turnstile

**Files:**
- Modify: `src/identity/auth.ts`, `src/identity/auth.test.ts`, `src/identity/env.ts`, `src/server/local-db.ts`, DM 6.11.
- Create: `src/identity/oauth.test.ts`, `src/identity/captcha.test.ts`, `src/identity/email-change.test.ts`, `src/routes/api/test.emails.ts`, `tests/helpers/discord.ts`.

**Interfaces:**
- Consumes: `queueEmail`, `createAuth`.
- Produces:
  - The local test mode: `VITE_LOCAL_DB=1` also turns on a memory `EmailSender` and a test-only route, `/api/test/emails`, for Playwright. Neither is in a normal build.
- Added to `createAuth`, whose `AuthDeps` gains `sender: EmailSender | null`:
  - `magicLink({ expiresIn: 900, storeToken: "hashed", sendMagicLink })`, with `expiresAt` passed to the outbox.
  - `emailVerification: { sendOnSignUp: true, autoSignInAfterVerification: true, sendVerificationEmail }`.
  - `emailAndPassword.sendResetPassword`.
  - `user.changeEmail: { enabled: true, updateEmailWithoutVerification: true }`: wave 4's "Wrong address? Change it" for an unconfirmed address.
  - `socialProviders.discord`, only when both Discord variables are set.
  - `account.accountLinking: { enabled: true }`, with **no `trustedProviders`** and `requireLocalEmailVerified` left at true. A comment says why, citing this plan's first finding.
  - `captcha({ provider: "cloudflare-turnstile", secretKey, endpoints: ["/sign-up/email", "/sign-in/email", "/sign-in/magic-link", "/request-password-reset", "/send-verification-email", "/change-email"] })`, on whenever a secret is set. Outside local mode a missing secret fails `parseAuthEnv`.
  - `rateLimit.customRules`: `/sign-in/magic-link` and `/request-password-reset` at 3 in 10 minutes, `/send-verification-email` at 1 in 40 seconds (wave 4's "Send it again (in 0:42)").
  - `hooks.before`: refuses `.invalid` addresses on magic link, reset and verification.
  - `hooks.after`: on `/change-email`, a verified account gets an `email_change_notice` to its old address. `/change-email`, `/change-password` and `/reset-password` write the audit rows `user.email.update` and `user.password.update`.
- Test helper: `signInWithDiscord(auth, fetchStub, { id, email, verified }): Promise<Response>`. It drives `/sign-in/social` to the `/callback/discord` redirect in-process, with `fetch` stubbed for Discord's token and `@me` URLs. No Discord application is involved.

- [ ] **Step 1: Write the failing tests.** `oauth.test.ts`:
  - `a new Discord user gets an account and a profile`;
  - `a verified Discord email links to a verified account, and it's the same user id`;
  - `an unverified Discord email matching an account can't get in`: the takeover from the first finding. **This test fails if `discord` is ever added to `trustedProviders`;**
  - `a verified Discord email can't link to an unverified local account`;
  - `a brand-new Discord user with an unverified email has email_verified false`, and `canPost` says no;
  - `a Discord user who signs in again gets the same user`;
  - `Discord's callback redirect is private, no-store`.

  `captcha.test.ts`, with `fetch` stubbed for siteverify:
  - `each protected path is refused with no token`, table-driven over the 6 paths;
  - `a good token passes` and `a bad one is refused`;
  - `a verify that hangs fails closed`.

  `email-change.test.ts`:
  - `an unverified address changes straight away and a new link goes out`;
  - `a verified address changes only after the new address confirms`;
  - `the old address gets a notice`;
  - `the change is audited with the addresses redacted`.

  In `auth.test.ts`:
  - `a magic link signs in once and not twice`;
  - `an expired link sends you to the error page, which offers a new one`;
  - `magic links are stored hashed`;
  - `a magic link for system@gridlocked.invalid does nothing`;
  - `a reset revokes other sessions`;
  - `a verification link marks the address verified`;
  - `a resend inside 40 seconds is refused`.
- [ ] **Step 2:** Run `pnpm test src/identity`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test src/identity`, `pnpm lint`, `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5:** Correct DM 6.11's Discord rows (linked only if both emails are verified, and not through trusted providers). Commit: `feat: magic link, Discord and Turnstile`.

### Task 6: Usernames

**Files:**
- Create: `src/identity/usernames.ts`, `src/identity/usernames.test.ts`.
- Modify: `src/identity/auth.ts`, `src/identity/auth.test.ts`, `src/settings/defaults.ts`, DM 6.3.

**Interfaces:**
- Consumes: `filter_rules`, `drivers`, `constructors`, `username_history`.
- Produces:
  - `normalizeForCheck(name): string`: lower case, with `_`, `0`→`o`, `1`→`l` handled for matching only. So `F1_0fficial` and `f1official` are compared alike.
  - `checkUsername(db, now, name, { userId? }): Promise<UsernameProblem | null>`, where `UsernameProblem` is `"format" | "reserved" | "held" | "taken"`. `reserved` covers active `filter_rules` for `usernames`, and any driver's or constructor's name, read live, so a new driver is covered without a seed.
  - `changeUsername(db, now, { userId, username }): Promise<void>`: one transaction, locking the user row. It refuses with `IdentityError` `username_too_soon` inside `username_change_days` (a setting, default 30), writes `username_history`, and sets `username_changed_at`. A unique violation comes back as `taken`.
  - The Better Auth `username` plugin with `minUsernameLength: 3`, `maxUsernameLength: 20`, `usernameValidator: checkUsername`, and `displayUsernameValidator`. `/sign-in/username` and `/is-username-available` are in `disabledPaths`, and `hooks.before` refuses a `username` on `/update-user`, so `changeUsername` is the only rename path.
  - `usernameHold` days, 90, a constant from the DM.

- [ ] **Step 1: Write the failing tests:**
  - `format`, table-driven: `ab`, a 21-character name, a space, `é`, a Cyrillic `а`;
  - `F1_Official, Formula1Fan, FIA_steward, admin and gridlocked are reserved`;
  - `MaxVerstappen and Ferrari are reserved`;
  - `a look-alike with zeros is reserved`;
  - `a rule turned off stops applying`;
  - `the name is taken whatever its case`;
  - `an old name is held for 90 days, then released`;
  - `a user can take their own old name back`;
  - `a second change inside 30 days is refused`;
  - `changing only the capitals isn't a change`;
  - `two people racing for one name: one wins, the other gets taken` (a unique-violation path through a stubbed check);
  - `sign-up with a reserved name is refused`, through the handler;
  - `renaming through update-user is refused`.
- [ ] **Step 2:** Run `pnpm test src/identity/usernames.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test src/identity`. Expected: PASS.
- [ ] **Step 5:** Update DM 6.3. Commit: `feat: usernames, reserved names and holds`.

### Task 7: Consent and the profile

**Files:**
- Create: `src/identity/consent.ts`, `consent.test.ts`, `profile.ts`, `profile.test.ts`, migration `identity_rules_2`.
- Modify: `src/identity/auth.ts`, `src/identity/viewer.ts`, DM 6.2 and 6.8.

**Interfaces:**
- Consumes: `syncAutoLeagues`; `checkUsername`.
- Produces:
  - `identity_rules_2` seeds `draft-1` of `terms`, `privacy` and `community_rules`, with `/legal/<kind>` urls.
  - `currentDocuments(db): Promise<LegalDocument[]>`, the latest per kind.
  - `pendingDocuments(db, userId): Promise<LegalDocument[]>`: those the user hasn't accepted, counting only a version with `requires_reacceptance` as new.
  - `completeSignUp(db, now, { userId, ageConfirmed: true, accepted: true, username? }): Promise<void>`, one transaction. It writes `age_confirmed_at` and the acceptances. It sets the username if there's none, using `checkUsername`.
  - `acceptDocuments(db, now, { userId, documentIds }): Promise<void>`, for re-acceptance.
  - `Viewer.complete`: `age_confirmed_at` is set, nothing is pending, and a username exists.
  - The email form's `hooks.before` on `/sign-up/email` requires `ageConfirmed` and `accepted` in the body, and the `create.after` hook calls `completeSignUp`. If that's lost, the gate below catches the account.
  - `purgeIncompleteAccounts(db, now, { olderThanDays = 7 }): Promise<number>`: hard-deletes accounts with no `age_confirmed_at`, past the limit, with no teams or memberships. It skips an account that an audit row names, because that foreign key restricts. Runs in Task 9's daily job.
  - `updateProfile(db, now, { userId, favoriteConstructorId?, favoriteDriverId?, countryCode?, timezone?, spoilerProtection? }): Promise<void>`, with a `version` check (DM 0.7). It validates `countryCode` and `timezone`, then calls `syncAutoLeagues` for every `running` game when a favorite or country changed.
  - `favoriteIsStale(db, userId, gameId): Promise<boolean>`: the favorite constructor isn't in the game, so settings can prompt (DM 6.11).

- [ ] **Step 1: Write the failing tests:**
  - `sign-up with the email form records the age and all three documents`;
  - `the email form is refused without either box`;
  - `a Discord user starts incomplete`, and `requireComplete refuses them`;
  - `completeSignUp finishes the account`;
  - `we store that they confirmed, never a birth date` (no such column, and the audit is empty);
  - `a new version with requires_reacceptance makes an account incomplete again`, `one without doesn't`;
  - `an incomplete account past 7 days is removed`, `a day-old one isn't`, `a finished one isn't`, `one an audit row names is skipped`;
  - `changing favorite team moves auto leagues`, `a null favorite leaves them`;
  - `a game that no longer has the favorite prompts again, and the flair stays`;
  - `two tabs saving a profile: the second gets a version conflict`;
  - `a bad country or timezone is refused`.
- [ ] **Step 2:** Run `pnpm test src/identity/consent.test.ts src/identity/profile.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test src/identity`. Expected: PASS.
- [ ] **Step 5:** Update DM 6.2 and 6.8. Commit: `feat: consent and the profile`.

### Task 8: Roles, staff two-step, bans and impersonation

**Files:**
- Create: `src/identity/roles.ts`, `roles.test.ts`, `staff-access.ts`, `staff-access.test.ts`, `impersonation.ts`, `impersonation.test.ts`.
- Modify: `src/identity/auth.ts`, `src/staff/roster.ts`, `src/staff/cli.ts`, `src/staff/cli.test.ts`, `scripts/staff.ts`, `.github/workflows/staff-action.yml`, `README.md`, DM 6.4.

**Interfaces:**
- Consumes: `writeAudit`, `redactPersonal`, `Viewer`.
- Produces:
  - `type Role = "user" | "moderator" | "admin" | "system"`. The access-control config (`createAccessControl`) is in `roles.ts`, with `user`, `moderator` and `admin`.
  - `twoFactor({ issuer: "Gridlocked", allowPasswordless: true, totpOptions: { period: 30 } })`, `allowPasswordless` because a Discord or magic-link staff member has no password.
  - `verifyStaffSession(auth, db, now, { viewer, code }): Promise<void>`: checks the TOTP code and sets `auth_sessions.staff_verified_at`, audited as `staff.session.verify`.
  - `requireStaff(viewer, role: "moderator" | "admin"): void`. It throws `staff_two_factor_required` if TOTP isn't enabled, and `staff_session_unverified` if `staff_verified_at` is null. An impersonated session never passes.
  - `setRole(db, now, { targetUserId, role, reason, actor }): Promise<void>`: one transaction with the audit `user.role.update`. It refuses `system`, a system target, and removing the last active admin. It revokes the target's sessions.
  - `banUser(db, now, { targetUserId, until, reason, actor })` and `unbanUser`: `banned`, `ban_expires`, sessions revoked, and audit `user.ban`, in one transaction. M7 adds the `mod_actions` mirror.
  - `StaffActor` gains an optional `userId`, and `audit()` writes it as `actorUserId`, so M8's screens and today's workflow both fit.
  - `startImpersonation(auth, db, now, { viewer, targetUserId, reason, headers })` and `stopImpersonating(...)`: admin only, verified session, audit `user.impersonate.start` and `.stop`, 1 hour (`impersonationSessionDuration: 3600`), other admins can't be impersonated.
  - `hooks.before` refuses every non-GET auth path for a session with `impersonated_by`, except `/sign-out` and `/admin/stop-impersonating`.
  - `pnpm staff set-role`: `STAFF_CHANGE = {"username": "...", "role": "admin"}`, added to the workflow's choices. It's the one command with no `STAFF_EVENT`. Dry run by default, and it prints only the username and the role change.

- [ ] **Step 1: Write the failing tests.** `roles.test.ts`:
  - `a role change writes the audit in the same transaction`, `needs a reason`;
  - `the last admin can't be demoted`;
  - `no one can be made system`;
  - `a banned user can't sign in`;
  - `their sessions are gone at once`;
  - `a temporary ban ends on its own`.

  `staff-access.test.ts`:
  - `an admin without TOTP can sign in, and staff tools stay locked`;
  - `password and TOTP sign-in, then a code, unlocks`;
  - `an admin with TOTP who signs in by magic link isn't unlocked`: finding 3;
  - `the same for Discord`;
  - `a wrong code leaves it locked, and repeated wrong codes hit the limit`;
  - `a backup code works once`;
  - `a new session starts locked`;
  - `a moderator can't pass an admin check`.

  `impersonation.test.ts`:
  - `only a verified admin can start`;
  - `start and stop are audited with both user ids`;
  - `it ends after one hour`;
  - `every non-GET auth path is refused while impersonating`, walking `auth.api` so a new endpoint is covered;
  - `requireWritable refuses it`;
  - `stop returns to the admin's own session`.

  In `src/staff/cli.test.ts`: `set-role resolves a username, dry run writes nothing, and the output has no email`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement, with `auth_sessions.staff_verified_at` declared as a Better Auth session field that's never accepted from input.
- [ ] **Step 4:** Run `pnpm test src/identity src/staff`, `pnpm lint`. Expected: PASS.
- [ ] **Step 5:** Update DM 6.4 and the README's staff section. Commit: `feat: roles, staff two-step and impersonation`.

### Task 9: Trust levels and the daily identity job

**Files:**
- Create: `src/identity/trust.ts`, `trust.test.ts`, `daily.ts`, `daily.test.ts`.
- Modify: `src/jobs/kinds.ts`, `src/jobs/sync-calendar.ts`, `src/jobs/sync-calendar.test.ts`, `src/jobs/functions/tick.ts`, `src/settings/defaults.ts`, DM 6.5.

**Interfaces:**
- Consumes: `purgeIncompleteAccounts`; `writeAudit`.
- Produces:
  - Setting `trust_thresholds`, with the numbers under "My calls".
  - `computeTrustLevel(input: TrustInput, t: TrustThresholds): 0 | 1 | 2 | 3`, pure. `TrustInput = { current; daysVisited; posts; reputation; upheldActions; accountAgeDays }`. It never returns below `current` unless `upheldActions > 0`.
  - `type TrustCounts = (db, userIds) => Promise<Map<string, { posts: number; upheldActions: number }>>`. M5's default returns zeros, so everyone stays at TL0 until M7 passes real counts.
  - `recomputeTrustLevels(db, now, { counts = noCounts, batch = 1000 }): Promise<{ changed: number }>`: active profiles seen in the last 30 days, skipping `trust_level_locked`, writing `trust_level_changes` with source `auto`.
  - `setTrustLevel(db, now, { userId, level, reason, actor })`: sets `trust_level_locked`, audited, source `moderator`.
  - `clearTrustLock(...)`, audited.
  - `pruneIdentity(db, now): Promise<void>`: expired `auth_sessions`, `auth_verifications` and `auth_rate_limits`; finished `email_outbox` rows older than 35 days, so the month's count stays right; `username_history` rows of tombstones past 90 days.
  - Job kind `identity_daily`, key `identity_daily:<yyyy-mm-dd>`. `sync_calendar` queues it, once a day, however many games there are. The handler runs `recomputeTrustLevels`, `purgeIncompleteAccounts`, `pruneIdentity`, and Task 10's `expireExports`, each in its own transaction, so a failure in one doesn't undo another.

- [ ] **Step 1: Write the failing tests.** `trust.test.ts`:
  - `each threshold, either side`, table-driven;
  - `going quiet never lowers a level`;
  - `an upheld action can`;
  - `a locked user is skipped`;
  - `each change writes a history row`;
  - `a moderator's change locks and is audited`;
  - `a deleted user is skipped`;
  - `running it twice writes nothing new`.

  `daily.test.ts`:
  - `expired rows go, live ones stay`, per table;
  - `a tombstone's old name is released after 90 days`;
  - `a live user's history stays`;
  - `sync_calendar queues one identity_daily a day`;
  - `a failure in one step leaves the others done`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test src/identity src/jobs`. Expected: PASS.
- [ ] **Step 5:** Update DM 6.5. Commit: `feat: trust levels and the daily identity job`.

### Task 10: Data export and account deletion

**Files:**
- Create: `src/identity/personal-data.ts`, `personal-data.test.ts`, `export.ts`, `export.test.ts`, `delete.ts`, `delete.test.ts`, `src/providers/storage/export-store.ts`.
- Modify: `neon.ts` (the `exports` bucket), `src/jobs/kinds.ts`, `src/jobs/functions/tick.ts`, `src/identity/daily.ts`, `src/game/lock.ts` if the test below shows a gap, `package.json`, DM 6.7.

**Interfaces:**
- Consumes: `writeAudit`, `queueEmail`, `enqueue`, the `teams` and `league_memberships` tables.
- Produces:
  - `PERSONAL_DATA: PersonalDataEntry[]`, one entry per table with a user column: `{ table; userColumn; onDelete: "scrub" | "delete" | "keep" | "retire"; why: string; exportAs: string | null; read?: (db, userId) => Promise<unknown> }`.
  - `interface ExportStore { put(key, body): Promise<void>; presign(key, seconds): Promise<string>; delete(key): Promise<void> }`, with the S3 adapter for the `exports` bucket and a memory one for tests. Neon injects the keys, as for the scheduler bucket.
  - `requestExport(db, now, { userId }): Promise<{ requestId: string }>`: one open request per user, and at most one a day. It queues `privacy_export`.
  - `buildExport(db, userId): Promise<object>`: the DM 6.7 list, from the registry, with provider names and never tokens. Posts, votes, chat and notification preferences join in M7 through the same registry.
  - `privacy_export` job: builds, stores `exports/<requestId>.json`, signs a link, sets `completed` and `export_expires_at`. It stops quietly, writing nothing, if the profile is `deleted`.
  - `expireExports(db, now, store): Promise<number>`: deletes files past expiry or belonging to deleted accounts.
  - `requestDeletion(db, now, { viewer, typedUsername }): Promise<{ confirm: "email" | "fresh_sign_in" }>`: a token, hashed, valid for 1 hour, in `privacy_requests`, sent as `delete_confirm`. An account with no verified email confirms by a sign-in in the last 10 minutes instead.
  - `confirmDeletion(db, now, { token }): Promise<void>`.
  - `scrubAccount(db, now, { userId, actor, reason? }): Promise<void>`, the DM 6.7 steps in one transaction, ordered by the registry:
    - the email becomes `deleted-<id>@deleted.invalid`; name, username, display username and image are cleared; `role` becomes `user`;
    - `auth_accounts`, `auth_sessions` and `auth_two_factors` are deleted;
    - profile fields are nulled, and `status = deleted`;
    - teams become retired, named "Deleted team", and every open membership ends;
    - leagues they own lose their owner and stay active;
    - queued `email_outbox` rows for the address are deleted;
    - `username_history` gets the name, for the 90-day hold;
    - the audit row `user.delete`.

    It refuses `system`, and the last active admin.

- [ ] **Step 1: Write the failing tests.** `personal-data.test.ts`:
  - `every table with a foreign key to users is in the registry`, walking the Drizzle schema with `getTableConfig`. **This is what makes M7 add its tables;**
  - `every entry names a real table and column`;
  - `every "keep" says why`.

  `delete.test.ts`:
  - `deletion leaves a tombstone that every foreign key still accepts`: a user with a team, a league, an audit row, an acceptance and a privacy request, then every FK column re-checked;
  - `no personal field survives`, comparing the row with an allow-list of columns;
  - `the email stays unique`: two deletions in a row;
  - `the wrong typed username is refused`;
  - `an expired or reused link does nothing`;
  - `an account with no verified email needs a recent sign-in`;
  - `the teams leave every league and show as Deleted team`;
  - `past standings keep them`;
  - `a league they own stays active with no owner`;
  - `a moderator can delete an under-16 account, audited`;
  - `the audit row has no email`.

  Review Focus 4: `a deleted address can't sign in by password, magic link or reset`; `Discord makes a new account, not the tombstone`; `the old email can sign up again`; `the username stays held for 90 days`.

  Review Focus 5: `a team deleted just before a lock isn't locked` (through `game_lock`); `the only admin can't delete themself`.

  `export.test.ts`:
  - `the export has the DM's sections`, `has no tokens, hashes or secrets` (searching the JSON);
  - `one open request at a time, and one a day`;
  - `the file is gone after 7 days`;
  - `an export job for a deleted user stops, and any file goes at the next daily run`;
  - `the link is signed for 7 days`, against the memory store's recorded seconds.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement. Add `@aws-sdk/s3-request-presigner`, pinned. Add `exports: {}` to `neon.ts` buckets.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5:** Update DM 6.7, including what moves to M7. Commit: `feat: data export and account deletion`.

### Task 11: shadcn/ui on Base UI, and the first components

**Files:**
- Create: `components.json`, `src/lib/utils.ts`, `src/lib/use-hydrated.ts`, `src/components/ui/button.tsx`, `text-field.tsx`, `checkbox.tsx`, `switch.tsx`, `badge.tsx`, `toast.tsx`, each with a test beside it, `e2e/hydration.spec.ts`, `src/routes/_dev.components.tsx` (local builds only).
- Modify: `package.json`, `src/styles/globals.css`.

**Interfaces:**
- Consumes: `spike/framework-start`'s `components.json` (`base-nova`, `rsc: false`), and the wave 1 components' names and props (the design system's component bundle).
- Produces:
  - `useHydrated(): boolean`, with `useSyncExternalStore`: false on the server and the first client render.
  - `Button` with the design system's `variant`, `size`, `block` and `disabled`. It renders **disabled until hydrated**, unless `staticLink` makes it a plain link.
  - `TextField` (`id`, `label`, `hint`, `error`, `type`), label wired to input and the error announced.
  - `Checkbox`, `Switch`, `Badge`, `Toast` (4 seconds, wave 1).
  - Every class is a design token: shadcn's `bg-primary` and the like are rewritten, because the default palette is gone.

- [ ] **Step 1: Write the failing tests:**
  - per component: `renders its label`, `disabled state`, `at least 44 px`, and the `TextField` error is linked with `aria-describedby`;
  - `useHydrated is false on the server`;
  - `e2e/hydration.spec.ts`: with the client bundle blocked, `a server-rendered Button is disabled`; with it loaded, `it's enabled`.
- [ ] **Step 2:** Run `pnpm test src/components src/lib && pnpm e2e e2e/hydration.spec.ts`. Expected: FAIL.
- [ ] **Step 3:** Run the shadcn CLI once to add the base files, then fit them to the design system. Pin every added dependency.
- [ ] **Step 4:** Run `pnpm test`, `pnpm lint`, `pnpm e2e`. Expected: PASS. `tests/lint/react-rules` stays green.
- [ ] **Step 5:** Commit: `feat: shadcn/ui on Base UI and the first components`.

### Task 12: Sign-up and onboarding screens

**Files:**
- Create:
  - `src/routes/sign-up.index.tsx`, `sign-up.email.tsx`, `sign-in.tsx`, `check-email.tsx`, `reset-password.tsx`, `welcome.index.tsx`, `welcome.favorites.tsx`, `welcome.spoilers.tsx`, `legal.$kind.tsx`, `auth-error.tsx`;
  - `src/components/turnstile.tsx`, `src/components/turnstile.test.tsx`, `src/server/account.ts`, `e2e/sign-up.spec.ts`, `e2e/sign-in.spec.ts`.
- Modify: `src/routes/__root.tsx` (a signed-in gate), `docs/design/03-ui-brief.md` (the Finish signing up screen).

**Interfaces:**
- Consumes: the Task 5, 6, 7 and 11 work; `getViewer`; `emailAllowance`.
- Produces:
  - Screens following wave 4's boards, with its copy: Choose a way in (Discord first), Sign up with email, Check your email (with the `busy` notice), Favorites (Step 1, skippable), Spoilers (Step 2, "Hide results" preselected).
  - **New, per decision 3:** `/welcome`, "Finish signing up": the two checkboxes and the username field. The footer of Choose a way in reads "You'll accept the terms in the next step" instead of "By continuing you agree".
  - The gate: a signed-in, incomplete viewer on any page goes to `/welcome`. Public pages stay public to logged-out visitors, with no session read when there's no cookie.
  - `<Turnstile onToken>`: renders Cloudflare's widget with `VITE_TURNSTILE_SITE_KEY`, and sends the token as `x-captcha-response`. In local mode it renders a labelled stand-in, so CI needs no network.
  - The `Continue with Discord` button shows only when Discord is configured.
  - Every signed-in route's `headers()` sends `private, no-store`.
  - Server functions in `src/server/account.ts`, each validated with Zod and checking `requireViewer` or `requireWritable`: `finishSignUp`, `saveFavorites`, `saveSpoilers`.

- [ ] **Step 1: Write the failing tests** (Playwright, at phone size, on the local build, reading emails from `/api/test/emails`):
  - `sign up with email, verify, onboard, land home`;
  - `a magic link signs a new person in, then Finish signing up, then home`;
  - `a person who skips Finish signing up can't reach home`;
  - `the two boxes are required`, `a reserved username shows why`, with no page reload;
  - `the busy notice shows when the allowance is tight`;
  - `an expired link offers a new one`;
  - `password reset works and the old password stops`;
  - `a banned user sees a plain message`;
  - `each form works with the keyboard alone`, and `an axe check finds nothing serious` on each screen;
  - `the Create account button stays disabled until hydrated`.

  `turnstile.test.tsx`: `the local stand-in gives a token`, `the real widget's script loads only on pages that need it`.
- [ ] **Step 2:** Run `pnpm e2e e2e/sign-up.spec.ts e2e/sign-in.spec.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm e2e` and `pnpm test`. Expected: PASS. Look at each screen in both themes at phone size.
- [ ] **Step 5:** Update the UI brief. Commit: `feat: sign-up and onboarding screens`.

### Task 13: Profile and settings screens

**Files:**
- Create: `src/routes/profile.tsx`, `settings.index.tsx`, `settings.username.tsx`, `settings.sign-in.tsx`, `settings.security.tsx`, `settings.data.tsx`, `settings.delete.tsx`, `settings.delete.confirm.tsx`, `e2e/settings.spec.ts`, `e2e/staff-access.spec.ts`.
- Modify: `src/server/account.ts`, `src/routes/__root.tsx` (the impersonation banner).

**Interfaces:**
- Consumes: Tasks 6–10; `changeUsername`, `updateProfile`, `requestExport`, `requestDeletion`, `confirmDeletion`, `verifyStaffSession`.
- Produces:
  - `/profile`: username, trust level in plain words (Task 9's level as "New", "Basic", "Member", "Regular", with one sentence on what it allows), favorites and join date. Teams and recent posts join in M6 and M7.
  - `/settings`: Spoilers, Appearance (the existing `gridlocked-theme` setting) and Account and privacy. Push settings join in M7.
  - `/settings/username` shows when the next change is allowed. `/settings/sign-in` lists methods, and links or unlinks Discord, refusing to remove the last method.
  - `/settings/security`: password change, and TOTP set-up with backup codes for staff. It's where `requireStaff`'s two refusals send you.
  - `/settings/data`: request, status ("Ready within a few hours"), and download until expiry.
  - `/settings/delete` and the confirm page: wave 4's board.
  - The impersonation banner, on every page while `impersonatedBy` is set, with a Stop button.
  - Staff screens themselves are M8.

- [ ] **Step 1: Write the failing tests** (Playwright, at phone size):
  - `a username change shows the next date, and a second is refused`;
  - `spoiler and favorite changes persist after a reload`;
  - `the last sign-in method can't be removed`;
  - `delete: the wrong username keeps the button disabled, the email link finishes, and sign-in then fails`;
  - `request an export, run the job, download the file`;
  - `the settings page is private, no-store`;
  - `a new admin sets up TOTP and keeps the backup codes`;
  - `the impersonation banner shows and Stop returns`.
- [ ] **Step 2:** Run `pnpm e2e e2e/settings.spec.ts e2e/staff-access.spec.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm e2e` and `pnpm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: profile and settings screens`.

### Task 14: The empty `diff_summary`

Today, a run's `before` figures come from the current lines. If an earlier run was superseded or failed after writing its lines, those lines were never published, so the new run compares against the wrong thing and reports little or no change. M7's correction notice ("your score changed by +3") would read this. It's also the deferred "a retried run's `diff_summary` understates what changed".

**Files:**
- Modify: `src/game/scoring-runs.ts`, `src/game/scoring-runs.test.ts`, DM 4.1.

**Interfaces:**
- Consumes: `writeAssetLines`, `writeTeamAdjustments`, `currentRun`.
- Produces:
  - Assets: when the current run isn't `succeeded`, an asset's `before` is taken from that run's `diff_summary.assets[].before` where listed, and otherwise from the current lines. `previousRunId` names the run actually published, the latest `succeeded`.
  - Teams: `before` is the team's `team_event_totals.points` for the event (0 with no row), which only a finished run moves, and `change` is `after - before`.

- [ ] **Step 1: Write the failing tests:**
  - `a superseded run's lines don't hide the change`: run A succeeds with 25 points, run B writes 18 and stops, run C writes 15. C's diff says 25 to 15 for the asset, and the right team change;
  - `the same after a failed run`;
  - `a chain of two superseded runs still reaches the published figure`;
  - `an ordinary second run reports what it did before`;
  - `a run that ends where the published figure was reports no change`;
  - `a dry run still writes no lines`.
- [ ] **Step 2:** Run `pnpm test src/game/scoring-runs.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS, with the season replays unchanged, since they never supersede mid-run.
- [ ] **Step 5:** Update DM 4.1. Commit: `fix: a run's diff compares with what was published`.

### Task 15: Staging, and the exit

**This task waits on the four approvals.** Everything before Step 3 is safe to merge without them.

**Files:**
- Modify: `.github/workflows/deploy-staging.yml`, `README.md`, `docs/design/04-implementation-plan.md`, HLD §11.2.
- Create: `e2e/staging-smoke.spec.ts` (run by hand, not in CI).

**Interfaces:**
- Consumes: everything above, and the values in [What each task needs from you](#what-each-task-needs-from-you).
- Produces:
  - **Deploy staging** gains steps after the migrations: `NITRO_PRESET=vercel pnpm build`, a check that `.vercel/output` contains no `pglite`, then `vercel deploy --prebuilt --prod` with the pinned Vercel CLI. They're skipped with a notice when `VERCEL_TOKEN` is unset, so the scheduler deploy keeps working.

- [ ] **Step 1: Check the deploy logic with no secrets:** run the build with the `vercel` preset locally, and check `.vercel/output/config.json` exists and the `pglite` check passes.
- [ ] **Step 2:** Add the workflow steps and the README section. Merge. Expected: CI green, nothing deployed.
- [ ] **Step 3: You create the four things** in the table, one at a time, starting with Vercel. I never see a value.
- [ ] **Step 4:** With your OK, and not during a race weekend, run Deploy staging. Expected: the migrations apply, the tick keeps its triggers, and the site answers on its fixed address.
- [ ] **Step 5:** Run `e2e/staging-smoke.spec.ts` and the checks below against staging, in the browser pane:
  - sign up with the email form using your Resend address (you enter it and read the email), then verify and onboard;
  - a magic link arrives and works once;
  - Discord signs in, and links to that verified account;
  - Turnstile really refuses a missing token;
  - the session cookie and `/api/auth/*` headers match the Global Constraints;
  - a logged-out home page sets no cookie;
  - `pnpm staff set-role` makes you an admin through the workflow, and TOTP unlocks staff access;
  - delete a second test account, and it can't sign in.
- [ ] **Step 6:** Record the result in the roadmap's M5 section, with the deploy run ids, as M2 and M3 did. Remove any test accounts you don't want kept. Commit: `docs: M5's result`.

## Scenario coverage (DM 6.11 and the roadmap's key tests)
| Scenario or key test | Where it's proved |
|---|---|
| Email and password sign-up | 3, 7, 12 |
| Launch-day rush beyond 100 sign-ups | 4: the caps · 12: the busy notice |
| Magic link expires before it arrives | 4: not sent · 5, 12: offers a new one |
| Discord sign-in with an email matching an account | 5: both verified, or no link |
| Discord account with an unverified email | 5: `canPost` says no |
| Email change | 5 |
| A username that looks official | 6 |
| A renamed user's old name grabbed; the 90-day hold | 6 |
| Someone under 16 | 10: moderator deletion. M8 adds the screen |
| Account deletion; a tombstone every foreign key accepts | 10 |
| Data export request | 10. **An export including archived chat: M7,** through the registry (decision 4) |
| Temporary ban | 8. The `mod_actions` mirror: M7 |
| Ban evasion with a new account | 9: a new account starts at TL0. M7 enforces the limits |
| Staff account phished | 8 |
| An admin investigates a user's issue | 8, 13 |
| Two admins edit the same setting | 7's `version` check. Settings screens: M8 |
| A moderator's level shouldn't change | 9 |
| A favorite team leaves F1 | 7 |
| Terms updated | 7 |
| Ads switched on later | **M8** adds `feature_flags` and `consent_records` |
| Better Auth upgrade adds columns | 1: auth tables stay apart. 3: the lint rule |
| The audit log is append-only | Already pinned (`src/audit/log.test.ts`) · 2: redaction |
| "No posting until verified" | 3: `canPost`. M7 calls it |

## Not in M5
- The forum, chat, notifications and push (M7), so `canPost`, the trust counts and the moderation mirror are seams for now.
- Staff screens (M8): user lookup, role and ban screens, the review of `email_cap_near`.
- The team builder and leagues screens (M6), including the join-code limit's call site.
- The real legal text, the production Neon and Vercel projects, the sending domain and Sentry (M9).
- `@`-mention rename handling (M7): `post_mentions` doesn't exist yet.

## After approval
Done on 7 Nov 2026, once this plan merged:
1. One task issue per task, as sub-issues of #6, with the board fields set.
2. Vercel and the `exports` bucket added to the epic's approval list, and "an export including archived chat" moved to M7 in the roadmap.

Work starts on Task 1 when you say so, with Tasks 11 and 14 alongside it if you like. Nothing is built yet.
