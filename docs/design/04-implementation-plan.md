# Gridlocked — Implementation Plan (phase 4)

**Status:** Draft for your review (2026-10-27).
**Builds on:**
- [01-high-level-design.md](01-high-level-design.md) (HLD);
- [02-data-model.md](02-data-model.md) (DM);
- [03-ui-brief.md](03-ui-brief.md) (UI) and its Claude Design canvases.

All three were approved on 2026-10-27.

This is the roadmap for phase 5, the build. It splits the work into milestones that each end in something working and tested. Each milestone is approved before it starts, and it's tracked on GitHub. The detailed, step-by-step plan for a milestone is written just before that milestone begins, so it reflects what the earlier ones taught us. The first one, M0, is written now: [plans/M0-foundations.md](../plans/M0-foundations.md).

## How we work

### GitHub
| Thing | Use |
|---|---|
| **Repository** | `psmak4/gridlocked`, **public** since 2026-10-27, with no license, so all rights are reserved. The working name is pending the trademark check (HLD §13.1). A rename later is cheap and GitHub redirects old links |
| **Milestones** | One per build milestone below, each with a target date |
| **Epic issues** | One per milestone (label `type:epic`). It holds the goal, scope and exit criteria, with the milestone's task issues attached as **sub-issues** |
| **Task issues** | One per task in a milestone's detailed plan (label `type:task`). Each has acceptance criteria, the tests that prove it, and a link to its plan section. They're written when the milestone's plan is written |
| **Labels** | `type:` epic, task, spike, bug, chore, docs · `area:` infra, data, results, fantasy, scoring, community, identity, staff, ui, legal |
| **Project board** | "Gridlocked" (GitHub Projects), with fields for **Status** (Todo, In progress, Done), **Priority** (P0 must-have for launch, P1 should, P2 could) and **Size** (S under half a day, M about a day, L split it) |
| **Templates** | Issue templates for task, bug and spike, and a pull-request template with the definition of done |

### Workflow (decided 2026-10-27)
- **A branch and a pull request per issue.** Branches are named `m0/3-clock`: the milestone, the issue number and a slug. The PR says `Closes #3`, CI must pass, and then it's merged with a squash.
- **`main` is protected by the "Protect main" ruleset (public repo, 2026-10-27):**
  - changes only through a pull request, squash-merged;
  - linear history, no force-pushes, no deletion, review threads resolved;
  - no required approvals, since there's one maintainer;
  - CI's `checks` becomes a required status check in M0 Task 8.
- **Repo security settings:**
  - secret scanning with push protection;
  - Dependabot alerts and security updates (plus weekly version updates in `.github/dependabot.yml`);
  - private vulnerability reporting (see `SECURITY.md`);
  - Actions tokens read-only by default;
  - workflow runs from outside contributors' PRs need approval;
  - CodeQL turns on in M0 Task 8, once there's code to scan.
- **Phase gates still apply.** Each milestone starts only on your approval. Anything that creates cloud resources (Neon, Vercel, Resend, Sentry, Cloudflare Turnstile, Discord app) is listed under that milestone's **Approval needed**. Nothing is created before you say yes to that list.

### Definition of done (every task)
1. The tests named in the task were written first and fail without the change. They pass with it.
2. Lint, type-check, unit tests, build and the relevant E2E tests pass in CI.
3. Accessibility basics hold for UI: real controls, labels and contrast, using design-system tokens only.
4. The task's docs are updated, and any decision it made is written down in the plan or the DM.
5. The PR is reviewed, then merged, and the issue closes.

### Testing policy (HLD §12)
- **Test first.** Every task starts with a failing test.
- **Scoring gets the most tests:**
  - golden cases for every rule;
  - property tests (constructor = sum of its drivers plus bonuses; re-scoring is idempotent; totals = sum of lines);
  - a full 2026 replay.
- **The database is tested as a database.** Constraints, triggers and the lock rule are tested against real Postgres. That's PGlite in tests, which is in-process Postgres 17 with no Docker needed, and Neon in staging. Mocks never stand in for SQL behavior.
- **The 2026 replay harness is the integration environment** (HLD §12). Stored provider snapshots plus the simulated clock (`app_now()`, DM 3.7) re-run whole race weekends.
- **E2E runs in Playwright at phone size,** for each flow the UI waves designed.

### Environments
| Environment | What | When it exists |
|---|---|---|
| Local | Next.js dev server and PGlite. No cloud accounts needed | M0 |
| Staging | Its own free Neon project, `gridlocked-staging` in AWS US East 1 (HLD §11.4), plus Vercel preview deploys | Neon from M1 (approved 2026-10-28); Vercel from M5 |
| Production | Vercel Hobby plus the production Neon project | M9, on approval |

## Milestones
Target dates assume steady work and are yours to move. The ordering is what matters: each milestone depends only on the ones above it, except where noted.

### M0 — Foundations (target 6 Nov)
- **Goal:** an empty but real app, with every tool and guard rail in place, so later milestones only add features.
- **Scope:**
  - the Next.js App Router app (TypeScript strict, pnpm, Node 24 LTS), ESLint and Prettier;
  - Vitest and Playwright;
  - the GitHub Actions CI;
  - the injectable clock;
  - UUIDv7 IDs;
  - money units ($0.1M);
  - Drizzle with migrations against PGlite;
  - the `settings` table and `app_now()`;
  - design-system tokens and fonts wired into Tailwind;
  - the app shell with the "unofficial" footer.
- **Key tests:**
  - clock behavior;
  - UUIDv7 ordering;
  - money parsing and formatting;
  - `app_now()` switching to the simulated clock;
  - every token pairing passing AA contrast in both themes;
  - an E2E smoke test that the footer disclaimer renders at phone size.
- **Exit:** a PR flow works end to end, with CI green on a PR that closes an issue.
- **Approval needed:** none. Everything is local or on GitHub.
- **Plan:** [plans/M0-foundations.md](../plans/M0-foundations.md).

### M1 — Spike: the scheduler tick and the free-tier budget (target 13 Nov; throwaway)
- **Goal:** prove or disprove the scheduling half of HLD §11.2 and §4.5 before we depend on it.
- **Changed 2026-10-28:** live chat was taken out of the spike. Neon's default of 100 concurrent function invocations per account, where each open WebSocket counts as one, ruled it out for launch (HLD decision 19). Chat-mode threads refresh instead, and M7 measures that on staging. The Vercel project moved to M2, since nothing in the spike needs a preview deploy.
- **Scope:**
  - a cron-triggered Neon Function, run every minute, that reads the due-times file and wakes Postgres only when something is due (HLD §4.5): this is where the file's home gets decided;
  - a small job table with uniqueness keys, so a duplicate tick can't double-act;
  - the hourly safety tick that checks the job table directly;
  - measured database compute-hours, Function capacity-hours and invocations, Object Storage use and transfer, extrapolated to a month and a race weekend.
- **Exit:** a short written result in `docs/spikes/M1-scheduler.md`. Either the tick fits the free tier as designed, or we change the design. The spike's code is deleted; the result and any design changes carry on.
- **Approval given (2026-10-28):** the `gridlocked-staging` Neon project, Free plan, AWS US East 1.
- **Plan:** [plans/M1-spike.md](../plans/M1-spike.md).

### M2 — Reference data and the results pipeline (target 27 Nov)
- **Goal:** real 2026 data flows in, and it's trusted and correctable.
- **Scope:**
  - **Reference data** (DM Part 1): seasons, circuits, events, sessions, drivers, constructors, seats, entries, availability, provider IDs.
  - **Ingestion and results** (DM Part 2):
    - the rate-limited provider client;
    - the Jolpica and OpenF1 adapters;
    - raw snapshots, the normalizer, results and the change log;
    - overrides and effective results;
    - review items, the job table, the scheduler and due-times file, and the poller and finalizer.
  - **The 2026 import and the replay harness.**
- **Key tests:**
  - every Part 1 and Part 2 scenario table row has a test, for example the renumbered 2026 rounds, "retired but classified", a Q3 driver with no time, and a pit-lane start (synthetic);
  - provider-after-manual;
  - duplicate ticks.
- **Exit:**
  - the whole 2026 season imports from stored snapshots;
  - a live 2026 weekend (Qatar, 29 Nov, or Abu Dhabi, 6 Dec) is ingested end to end in staging, with no admin action needed on a clean weekend.
- **Approval needed:** a Neon API key for `gridlocked-staging` and its database URL, stored as GitHub Actions secrets, so CI can run migrations and deploy the staging jobs (Task 12 of the plan). The Vercel project moved again, to M5, the first milestone with pages to preview (2026-10-28).
- **Plan:** [plans/M2-reference-and-results.md](../plans/M2-reference-and-results.md).

### M3 — Fantasy core (target 11 Dec)
- **Goal:** teams can be built, locked and changed exactly by the rules.
- **Scope (DM Part 3):**
  - games, ruleset versions with the 2026 rules as data, and our chip names;
  - the pool and per-event prices;
  - teams (3 per user), lineup versions with the database-enforced lock;
  - transfers and carry-over, team value and the bank;
  - chips, including Limitless and Final Fix versions, and cancellations.
- **Key tests:** every Part 3 scenario row, including:
  - a save at the deadline;
  - net transfers and reverts;
  - carry-over capped at 1;
  - a Limitless revert;
  - Final Fix with the Boost moving;
  - an x3 Boost on the 2x driver being rejected;
  - a cancelled event refunding chips.
- **Exit:** the 2026 replay runs locks, transfers and chips for scripted teams across the season with no rule violations.

### M4 — Scoring and standings (target 23 Dec)
- **Goal:** every point is right and explainable, and corrections ripple through.
- **Scope (DM Part 4):**
  - the scoring engine as pure functions;
  - asset score lines;
  - team adjustment lines, with base lines as a view;
  - event totals and the earliest-to-reach tiebreak;
  - leagues (global, public, private, auto, mini) and their standings;
  - the scoring pipeline and the dry run.
- **Key tests:**
  - golden cases for every 2026 rule;
  - the property tests above;
  - the Hadjar, Lawson and Tsunoda rounds 12–14;
  - Autopilot ties;
  - No Negative per category;
  - a correction rippling to later events;
  - concurrent re-scores.
- **Exit:**
  - the full 2026 replay produces totals for scripted teams;
  - a manual cross-check against the official game for 3 sampled races matches after removing the excluded categories (HLD §12).

### M5 — Identity and accounts (target 8 Jan; can start alongside M3–M4)
- **Goal:** people can sign up safely, and staff accounts are secured.
- **Scope (DM Part 6, UI wave 4 sign-up):**
  - Better Auth self-hosted, with the table renames;
  - email + password, magic link and Discord sign-in;
  - Turnstile;
  - the age confirmation and legal acceptances;
  - profiles, usernames and reserved names;
  - roles, two-step sign-in for staff, and impersonation rules;
  - trust levels;
  - the email outbox and its daily cap;
  - data export and the anonymizing account deletion;
  - the audit log.
- **Key tests:**
  - a Discord sign-in linking to an existing account;
  - a reserved or official-looking username;
  - a 90-day username hold;
  - deletion leaving a tombstone that every foreign key still accepts;
  - an export including archived chat;
  - the audit log being append-only.
- **Approval needed:**
  - a Resend account, Free;
  - a Cloudflare Turnstile site key, free;
  - a Discord application, for OAuth;
  - a Vercel project, Hobby, linked to the repo for preview deploys against `gridlocked-staging` (moved here from M1 and M2 on 2026-10-28). You install Vercel's GitHub app.

### M6 — Fantasy screens (target 22 Jan)
- **Goal:** the game is playable on a phone.
- **Scope:** UI waves 2–3:
  - the team builder (ready, over-cap, locked);
  - the driver picker and the chip sheet;
  - home and the weekend hub;
  - the points breakdown and the driver sheet;
  - leagues, standings, create and join;
  - prices and "How prices work";
  - the desktop shell.

  The design-system components are rebuilt on shadcn/ui with the same names and props (DS README).
- **Key tests:** E2E at phone size for building a team, the lock, chips, joining a league, the breakdown, and spoiler-gated scores.

### M7 — Community (target 5 Feb)
- **Goal:** race weekends feel alive.
- **Scope:**
  - DM Part 5: categories, threads, nested posts, votes, search (if you approve it at this milestone), watch marks;
  - chat-mode threads that refresh every few seconds through the `RealtimeChannel` interface, cached per thread on the CDN (HLD decision 19), and the 30-day archive;
  - a staging load test that the CDN absorbs a race start's refreshes within Vercel Hobby's limits;
  - reports, the moderation queue and filters;
  - notifications, broadcasts, Web Push and the email outbox;
  - UI waves 2 and 4.
- **Key tests:**
  - every Part 5 scenario row;
  - spoiler protection across titles, chat, scores and notifications;
  - logged-out visitors being spoiler-safe;
  - slow mode;
  - the spoiler title check;
  - a report flow and auto-hide.

### M8 — Staff tools (target 12 Feb)
- **Goal:** a normal weekend needs no staff, and an abnormal one is quick to fix.
- **Scope:** UI wave 5:
  - the review queue;
  - corrections;
  - the dry run and approval;
  - the moderation queue;
  - calendar and lock times;
  - seats and availability;
  - the price publish;
  - settings, feature flags and usage meters;
  - the audit log.
- **Key tests:**
  - every staff write being audited with a reason;
  - a lock never moving into the past;
  - optimistic concurrency, so two staff can't resolve the same item.

### M9 — Hardening and closed beta (beta 15 Feb – 5 Mar)
- **Goal:** prove it on real people with replayed 2026 weekends.
- **Scope:**
  - load tests: the race-end spike and chat-mode refreshes;
  - the free-tier budget test (HLD §12.7);
  - an accessibility audit and a security review;
  - Sentry and usage alerts;
  - backups and a restore drill;
  - legal pages from your lawyer;
  - the closed beta on replayed weekends;
  - a bug-fix pass.
- **Approval needed:**
  - the production Neon project;
  - the production Vercel project and domain;
  - Sentry, free.

### M10 — Launch (first 2027 race weekend, date TBC)
- **Goal:** open the doors for the 2027 opener.
- **Scope:**
  - seeding the 2027 calendar, entry list and starting prices (HLD §2: Jolpica has no 2027 data yet);
  - the 2027 ruleset if the official game changes;
  - runbooks for race weekends, outages and corrections;
  - the launch checklist, then go.

## What's deliberately not in this plan
- **Anything after launch** (HLD §15 "soon after" and "later"): hub pages, league threads, pick reveal, the rumor tracker, image uploads, Google and Apple sign-in, native apps and ads (HLD §16).
- **Detailed tasks for M1–M10.** Each is written just before its milestone and becomes that milestone's task issues.
