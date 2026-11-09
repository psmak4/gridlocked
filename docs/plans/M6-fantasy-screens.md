# M6 Fantasy Screens Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the game is playable on a phone (roadmap M6, epic psmak4/gridlocked#7).

**Exit:**
- phone-size Playwright tests pass for building a team, the lock, chips, joining a league, the breakdown and spoiler-gated scores (the roadmap's key tests), on a local build that runs 2026 weekends on the simulated clock;
- every screen in the [scenario table](#scenario-coverage-ui-waves-23-and-the-roadmaps-key-tests) has a test, or a named later milestone;
- the M5 carry-overs are done;
- staging runs the new screens (decision 5 says how far).

**Architecture:**
- **No new game rules.** M3 and M4 built and tested every rule. M6 adds **read models** (what a screen shows) and thin **server functions** (what a button does) on top of them. A save still goes through `saveLineup`, a chip through `playChip`, a join through `joinLeague`. The database stays the judge.
- **A new module, `src/play/`, holds the read models.** Each is a function `(db, now, input) → plain object`, tested on PGlite without the Start runtime, like M5's `src/server/*-actions.ts`. `src/server/play.ts` wraps each in a Zod-checked `createServerFn`, reading the viewer and the request's clock once (`withRequestNow`).
- **Spoilers are a module of their own, `src/spoilers/`.** One batched check says which sessions a viewer may see. Every read model that carries a score, a rank or a price change asks it first, and **leaves the hidden figures out of what it returns.** A hidden number never reaches the browser, so it can't leak through the page source or a screen reader (the design system's `SpoilerCover` rule).
- **The design-system components are rebuilt in `src/components/ui/`** with the README's names and props, on Base UI where there's a primitive (Sheet on Dialog, Tabs on Tabs). Screens use only these and the tokens.
- **The fantasy e2e runs on its own local server in replay mode,** so a test can move the clock past a lock and run the real lock and scoring jobs on recorded 2026 results.

**Tech Stack:** TanStack Start, React 19, Drizzle, Postgres (PGlite in tests and local runs, Neon in staging), Zod, shadcn/ui on Base UI 1.9.0, Tailwind 4 with the design-system tokens, Vitest, Playwright with axe-core. **No new dependencies.**

**Spec:**
- [03-ui-brief.md](../design/03-ui-brief.md) waves 2 and 3, and their canvases for the exact copy: [wave 2](https://claude.ai/artifact/6ffGHC4QcgEgRZv6pGgwfU) and [wave 3](https://claude.ai/artifact/BbF1XbqGJnSS9SwGRh1pHD);
- the design system [Gridlocked](https://claude.ai/artifact/PUXqoEEV5XrSJtsfELx7b9): its README and `components/index.d.ts` (names and props) and each component's README;
- [02-data-model.md](../design/02-data-model.md) Part 3 (3.5–3.9), Part 4 (4.2–4.7) and 5.7 (`session_watch_marks`);
- [01-high-level-design.md](../design/01-high-level-design.md) §5, §7.3 and §11.4;
- [04-implementation-plan.md](../design/04-implementation-plan.md) M6, including "Carried from M5".

## What checking the spec turned up
I read the M3–M5 code these screens sit on. These change what the roadmap says, and the tasks below follow them.

1. **The spoiler state is M7's table, but M6's key test needs it.** "Mark as watched" is on the wave 2 and 3 boards, and DM 5.7's `session_watch_marks` is in Part 5, which the roadmap puts in M7 (decision 1).
2. **A team never reaches its auto leagues before the first lock.** `createTeam` doesn't call `syncAutoLeagues`, and `updateProfile` syncs only `running` games. A game is `open`, not `running`, until its first event locks, so in the whole preseason a new team has no "Ferrari fans" league and a changed favorite moves nothing. Tasks 1 and 6 fix both.
3. **Logged-out pages would have to open the database.** M5's rule is "logged-out pages never open the database". A public weekend hub or prices page can't be built without reading the calendar and prices. HLD §11.4 means such pages to be cached on the CDN, so most visits never reach the database (decision 3).
4. **Price changes give results away.** A driver's "▲ $0.6M" says he had a great weekend. Prices move when the event is final, at least 2 days after the race, inside the 7-day spoiler window. HLD §7.3's list doesn't name prices (decision 4).
5. **Two of the board's session states have no data.** Nothing sets "Delayed". `sessions.status` has `suspended` (the board's "red flag") and `abandoned` ("ended early"), and they're shown when it says so. A start that isn't confirmed is "TBC" (`start_confirmed`). "Live" comes from the clock, as HLD §7.2 says. "Delayed" waits for M8's calendar screen.
6. **The e2e server has one clock.** Playwright runs 7 workers against one server, and a lock test needs the clock past the lock while a builder test needs it before. So the fantasy specs get their own replay-mode server and run one at a time (Task 3).
7. **M4's exit, #127, is still open.** M6 reads M4's tables and functions, which are merged, not its exit. Nothing here waits on it.
8. **HLD §11.5 suggests TanStack Query,** which isn't installed. Route loaders, server functions and `router.invalidate()` cover these screens, as they did M5's, so M6 adds no dependency.
9. **The plans live in `docs/plans/`,** so this one is there too.

## Decisions for you (open)
These change what gets built. Each has my recommendation first. Nothing is built until you choose.

1. **Watch marks: build them now or in M7?**
   - **Recommended: now.** Task 4 adds DM 5.7's `session_watch_marks` table as written, with "Mark as watched" on the weekend hub, the breakdown and the locked team. M7 then uses the same table and check for threads and chat. It's one small table and one function, and the key test "spoiler-gated scores" proves the real thing.
   - **Not chosen: wait for M7.** M6 hides scores by the 7-day window and the profile switch only, with "Show it" for one item at a time. There's no "Mark as watched", so the boards' main reveal is missing for two milestones, and M6's spoiler test proves less.
2. **What a viewer sees of standings and season totals while the latest event is hidden.** A season total or a rank includes the hidden event, so either one gives it away.
   - **Recommended: cover them.** While any scored session of the latest event in a table is hidden, the table, the season total and the rank are replaced by a `SpoilerCover` ("Mexico City — standings are in") with Show it and Mark as watched. It reads the stored table once, as now.
   - **Not chosen: show them as they stood before the hidden event.** More useful, but a league's table before that event isn't stored (DM 4.7), so it's rebuilt on demand from `team_event_totals` for every hidden view, and the "up 3" arrows need their own rule.
3. **Which M6 pages a logged-out visitor can open.**
   - **Recommended: the weekend hub, prices and How prices work.** They're public, cached on the CDN for 60 seconds (`public, s-maxage=60, stale-while-revalidate=300`), and they read the database only on a cache miss. They never read a session. Teams, the breakdown, leagues and standings ask the visitor to sign in. The logged-out home stays the M5 page with a "See this weekend" link. M5's rule becomes "a logged-out request never reads a session; a public data page is cached".
   - **Not chosen: global and league standings public too.** Good for sharing a league, but each one needs the logged-out reveal toggle that HLD §7.3 keeps in the browser, which is M7's key test ("logged-out visitors being spoiler-safe"). It's more to build now and to cache.
4. **Are price changes spoilers?**
   - **Recommended: yes, by the same rule as scores.** The "going up / going down" list and each row's ▲▼ are covered while the race of the event that moved them is hidden for the viewer, and current prices always show. For a logged-out visitor that's the 7-day window, and "Show it" links to `/prices?show=changes`, a separately cached page.
   - **Not chosen: no.** Simpler, and the official game doesn't hide prices. But a fan who watches on Tuesday learns who had a great race from the prices page.
5. **The exit, and staging.** The roadmap gives M6 no staging exit. Staging has no game, and 2026's last round is Abu Dhabi on 6 Dec.
   - **Recommended: a local exit, plus one staging deploy to look at.** The exit is the replay-mode e2e (Task 15). Staging gets one deploy, with your OK and not on a race weekend, so you can open the screens on your phone. With no game they show their empty states ("The game opens before the first race"). Real play on staging comes with M9's closed beta on replayed weekends.
   - **Not chosen: a live game on staging for Abu Dhabi.** You'd play a real weekend on your phone through the real pipeline. It needs a new `pnpm staff create-game` command that starts a game at round 23 with our own prices (from our formula on the replay), a staging write through the Staff action workflow, and Tasks 6–9 merged by 4 Dec. If they're late, the chance is gone until March.

**My calls (lower stakes; each is written into the DM or UI brief when its task lands):**
- **Routes:** `/team` (your teams), `/team/$slot` (the builder), `/team/$slot/points` (the breakdown, `?round=`), `/weekend` (the hub), `/leagues`, `/leagues/new`, `/leagues/$slug`, `/prices`, `/prices/how`. The driver sheet, the chip sheet and Join with a code are sheets, not pages. A join code is never in a URL, so it doesn't reach logs.
- **The current game** is the game in status `open` or `running` with the latest season. With none, every fantasy screen shows one empty state.
- **The bottom nav has Home, Team, Leagues and Profile** until M7 adds Forum, and the header bell joins with notifications in M7. The desktop side menu (from 1024 px) has the same items in the same order.
- **Drafts stay in the browser** (DM 3.7): `localStorage` key `gridlocked:draft:<teamId>:<eventId>`, cleared on a successful save, and read in a `try`/`catch` so a private window works without it.
- **The builder shows prices at the open event.** Ownership ("Selected by 34%") is the share of teams locked at the latest locked event that hold the asset, computed on demand.
- **Join codes are rate-limited per user:** 10 tries in 10 minutes (`league_join_limit` setting), through M5's `consumeRateLimit`. "No league has that code" reads the same for a wrong code and a code from another game.
- **Lock times show in the viewer's time zone** (`profiles.timezone`, else the browser's), with the hub's Track switch for the circuit's.
- **Points line words** ("P3 · gained 3 places") come from one pure function over `rule_code` and `detail`, with a test per 2026 rule.
- **A correction note** shows when the event's current run for any session isn't its first, in one sentence by trigger: `results` "Updated after a stewards' decision", `override` the override's player-facing reason, `exception` "This session was voided", `ruleset_correction` and `engine_change` "Rescored after a rules fix".
- **The countdown** updates once a minute, and every second in the last 10 minutes (the design system's rule), with `formatCountdown`.
- **"Show it" is not stored.** It reveals one item until the page is left. "Mark as watched" is stored for a signed-in viewer.

## What each task needs from you
**Nothing in Tasks 1–15 needs an account, a key or a staging write.** They're built and tested against PGlite and a local build. Then:
- **Task 15, Step 6:** one Deploy staging run, with your OK, not on a race weekend (rounds 21–23 run to 6 Dec). It applies Task 4's migration and deploys the site. No new cloud resource.
- **Only if you choose the alternative in decision 5:** a Staff action workflow run that creates the game on staging, with its own OK.

## Global Constraints
- **No direct time.** Every function takes `now: Date` from its caller (HLD decision 20). Server functions resolve it once with `withRequestNow`.
- **The database judges every write.** Screens and read models never re-implement a rule to allow a save. `previewTeam` only gives the friendlier early answer, as `saveLineup`'s own `now` check does.
- **Every signed-in page and every server-function answer sends `Cache-Control: private, no-store`.** Public data pages (decision 3) send `public, s-maxage=60, stale-while-revalidate=300` and never read a session, set a cookie or vary by viewer.
- **Server-rendered controls stay disabled until hydrated** (`Button`'s rule, HLD §11.4).
- **Spoilers:** a read model returns no figure for a hidden session: no points, no total, no rank, no arrow, no price change. Titles, toasts and `<title>` say "results are in", never a result (design-system README).
- **Guards:** reads take `requireComplete`; every write takes `requireWritable`. An unverified email may build a team, play a chip and join a league (wave 4: "look around and build a team before confirming").
- **A refusal a screen can show comes back as `{ ok: false, error: GameErrorCode }`**, and the screen maps it to wave 2's copy. Anything else is `server_error` (M5's middleware).
- **UI uses design-system components and tokens only,** with targets of at least 44 px, rows of 56 px, body text of 16 px and numbers in Barlow Semi Condensed. One heat block per screen. Copy follows the canvases and the README's voice rules, and our chip names only: Strategist, Overdrive, Safety Car, Rebuild, Blank Cheque, Late Call.
- **No official F1 Fantasy numbers in the repo.** Seeds and e2e use `tests/fixtures/prices-2026.json` (our own) and our formula's prices.
- **No F1 marks.** No logos or photos; teams are a `TeamBadge` with a code.
- **Migrations:** schema in `src/db/schema/`, then `pnpm db:generate`; `pnpm db:drift` stays clean.
- **Workflow:** one branch `m6/<issue>-<slug>` and one PR per task, closing its issue. CI green before a squash-merge. No auto-merge, no force-push.

## Review Focus
1. **Two devices edit one team.** Expected: the second save still goes through, and the screen says "Your other device saved changes" with "See their team", without losing this device's draft. *Pinned in Task 8.*
2. **Save is pressed after the lock, on a page opened before it.** Expected: "Your team locked at 14:00", the screen turns to the locked state, and the draft stays in the browser, not silently discarded. *Pinned in Task 8.*
3. **A hidden result leaks through a figure next to it.** The season total, a rank, a league's "up 3", a price change, the total on a session tab, the page `<title>` or a toast. Expected: none of them is in the response while the session is hidden. *Pinned in Tasks 4, 11, 13 and 14.*
4. **Prices or the pool change under an open builder.** A new window opens with new prices, or a driver is withdrawn. Expected: the save is refused with words (`over_budget`, `asset_unavailable`), and the builder reloads its prices without losing the draft. *Pinned in Task 8.*
5. **Someone guesses join codes.** Expected: after 10 tries in 10 minutes every try says "Too many tries. Wait a few minutes.", a right code included, and a wrong code reads the same whatever league it might belong to. *Pinned in Task 12.*

---

## Tasks at a glance
| # | Task | Size | Needs first |
|---|---|---|---|
| 1 | M5 carry-overs in identity | S | |
| 2 | Design-system components, the second set | M | |
| 3 | The fantasy e2e harness, and the flaky sign-up spec | M | |
| 4 | Spoiler state: watch marks and the reveal check | S | |
| 5 | The app shell: current game, bottom nav and desktop menu | M | 2 |
| 6 | Teams: create, rename and remove | S | 1, 5 |
| 7 | The builder's read and save | M | 4, 6 |
| 8 | Team builder and driver picker screens | M | 3, 7 |
| 9 | Chips, Late Call and the locked team | M | 8 |
| 10 | Home and the weekend hub | M | 4, 5 |
| 11 | Points breakdown and the driver sheet | M | 4, 5 |
| 12 | Leagues: mine, create, join and leave | M | 6 |
| 13 | Standings | M | 4, 12 |
| 14 | Prices and How prices work | M | 4, 5 |
| 15 | The exit: every flow, both themes, and staging | M | everything |

Tasks 1, 2, 3 and 4 touch nothing in common and can run alongside each other. After Task 5, Tasks 10, 11 and 14 are independent of each other and of 6–9. Tasks 7, 8 and 9 all edit `src/play/builder.ts` and the builder route, so they run one at a time. Task 12 and 13 share `src/play/leagues.ts`.

### Task 1: M5 carry-overs in identity

**Files:**
- Modify: `src/identity/profile.ts`, `src/identity/profile.test.ts`, `src/identity/daily.test.ts`, `src/identity/lock-order.test.ts`, DM 6.2.

**Interfaces:**
- Consumes: `updateProfile`, `syncAutoLeagues`, the `aGame` helper in `daily.test.ts`.
- Produces:
  - `updateProfile` reads the profile row `FOR NO KEY UPDATE` before comparing, the lock order `lock-order.test.ts` pins (user, then profile).
  - `updateProfile` syncs auto leagues for every game in status `open` **or** `running` (finding 2).
  - `gamesForAutoLeagues(db): Promise<{ id: string }[]>`, exported from `profile.ts`, so Task 6 calls the same list.

- [ ] **Step 1: Write the failing tests.** `profile.test.ts`:
  - `changing favorite team moves auto leagues in an open game`;
  - `a failing syncAutoLeagues rolls the profile change back` (a `syncAutoLeagues` stub that throws; the profile's `version` and favorite are unchanged);
  - `two tabs saving at once: the second gets a version conflict` (it exists; it must stay green).

  `lock-order.test.ts`: `updateProfile locks the profile row before it reads it`, by the statements it sends, as the file's other paths are pinned (PGlite has one connection, so two transactions can't contend).

  `daily.test.ts`: `sync_calendar queues one identity_daily a day with two running games` (`aGame("running")` twice).
- [ ] **Step 2:** Run `pnpm test src/identity/profile.test.ts src/identity/daily.test.ts`. Expected: the open-game and lock-order tests FAIL. The rollback and two-games tests pin today's behavior and may already pass; they stay as guards.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test src/identity`. Expected: PASS.
- [ ] **Step 5:** Update DM 6.2 (auto leagues follow the profile in open and running games). Commit: `fix: auto leagues before the first lock, and the profile lock`.

### Task 2: Design-system components, the second set

**Files:**
- Create in `src/components/ui/`, each with a test beside it: `team-badge.tsx`, `asset-row.tsx`, `countdown-block.tsx`, `budget-meter.tsx`, `points-pill.tsx`, `tabs.tsx`, `sheet.tsx`, `spoiler-cover.tsx`, `empty-state.tsx`, `bottom-nav.tsx`, `icons.tsx`.
- Create: `src/design/team-ink.ts`, `src/design/team-ink.test.ts`.
- Modify: `src/components/ui/toast.tsx`, `toast.test.tsx`, `src/routes/_dev.components.tsx`, `e2e/components.spec.ts`.

**Interfaces:**
- Consumes: the props in the design system's `components/index.d.ts`, copied exactly; `contrast.ts`; `Badge`, `Button`.
- Produces:
  - `TeamBadge`, `AssetRow`, `CountdownBlock`, `BudgetMeter`, `PointsPill`, `Tabs`, `Sheet`, `SpoilerCover`, `EmptyState`, `BottomNav`, with the README props. Additions, each optional so the README props still work:
    - `Sheet`: `open: boolean`, `onClose: () => void`, `actions?: ReactNode`, on Base UI `Dialog`, as a bottom sheet under 1024 px and a centered dialog from it;
    - `Tabs`: on Base UI `Tabs`, so arrow keys move between tabs;
    - `AssetRow`: `disabled?: boolean` (untinted, `aria-disabled`, for "$0.4M over budget" rows);
    - `BudgetMeter`: renders `role="meter"` with `aria-valuetext` the same words it shows;
    - `SpoilerCover`: `hidden`'s children are **not rendered**; Show it and Mark as watched are real buttons, Mark as watched shown only when `onMarkWatched` is given.
  - `teamInk(color: string): "#0b0b1e" | "#ffffff"`: whichever passes 4.5:1 on `color`, preferring navy on a tie.
  - `teamTint(color: string, theme: Theme): string`: the color mixed into `surface` at 22% in dark and 12% in light.
  - `Icon` (`home`, `team`, `leagues`, `forum`, `profile`, `bell`): 24 px stroke icons, `aria-hidden`.
  - **Toast fixes (carried from M5):**
    - a hover pause comes only from a mouse (`pointerType === "mouse"`), so a tap on a touch screen doesn't hold the toast forever;
    - a focus pause also ends when the window loses focus, so a toast whose button was focused when the person switched apps still goes.

- [ ] **Step 1: Write the failing tests:**
  - per component: `renders its README example`, `at least 44 px` where it's interactive, and axe on the `_dev.components` page in both themes;
  - `teamInk` and `teamTint`, table-driven over all 11 constructor colors of 2026 from the reference fixtures: text tokens on each tint pass AA in both themes;
  - `SpoilerCover hidden leaves its children out of the DOM`, `Show it calls onReveal`, `Mark as watched is absent without onMarkWatched`;
  - `BudgetMeter reads "$97.8M of $100M"`, and over the cap `"Over by $1.4M"` with the heat bar;
  - `PointsPill shows the word Provisional or Final`;
  - `AssetRow with delta 0.2 shows ▲0.2 in rise, and with -0.1 shows ▼0.1 in fall`;
  - `BottomNav marks the active item with aria-current="page"`;
  - `Sheet closes on Cancel and Escape, and traps focus while open`;
  - `Tabs move with the arrow keys`;
  - toast: `a touch tap doesn't pause it`, `a mouse hover does`, `a focused toast dismisses after the window loses focus`.
- [ ] **Step 2:** Run `pnpm test src/components src/design`. Expected: FAIL.
- [ ] **Step 3:** Implement. Pull Base UI's Dialog and Tabs through the shadcn CLI once, then fit them to the tokens, as M5 did.
- [ ] **Step 4:** Run `pnpm test`, `pnpm lint`, `pnpm e2e e2e/components.spec.ts`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: the second set of design-system components`.

### Task 3: The fantasy e2e harness, and the flaky sign-up spec

**Files:**
- Create: `src/server/test-game.ts` (local builds only), `src/routes/api/test.game.ts`, `src/routes/api/test.clock.ts`, `e2e/helpers/game.ts`, `e2e/fantasy/harness.spec.ts`.
- Modify: `playwright.config.ts`, `.github/workflows/ci.yml`, `e2e/sign-up.spec.ts`, the CI check that the normal build has no test-hook markers.

**Interfaces:**
- Consumes: `seedGame2026`'s steps (`importReferenceFixtures2026`, `createGame`, `seedPool`, `publishPrices`), the replay's recorded provider and `runReplayClock`, `setSimulatedClock`, `localDb`.
- Produces:
  - A second Playwright project, `fantasy`, against its own server on port 3101, built with `VITE_LOCAL_DB=1` and started with `CLOCK_MODE=replay`. Its specs live in `e2e/fantasy/`, and CI runs it as its own step with `--workers=1`. The existing project is unchanged and never sees this server.
  - `POST /api/test/game` `{ at: string }`: resets the local database's game data, sets the simulated clock to `at`, and seeds the 2026 game from the recorded fixtures with our starting prices. Returns `{ gameId }`.
  - `POST /api/test/clock` `{ to: string }`: runs `runReplayClock` from the current simulated time to `to` with `jump` steps, so due jobs (lock, poll, score, finalize, price update) run on the recorded results. Returns `{ now, jobsRun }`.
  - `e2e/helpers/game.ts`: `seedGame(request, at)`, `moveClock(request, to)`, and `ROUND_1` with the times the specs need (`beforeLock`, `afterQualifying`, `afterRace`, `final`), read from the fixtures, not typed in.
  - Both routes return 404 unless `VITE_LOCAL_DB=1`, and their files carry a `test-hook` marker the build check looks for.

- [ ] **Step 1: Write the failing tests.** `e2e/fantasy/harness.spec.ts`:
  - `seeding gives an open game with round 1 open and priced`;
  - `moving the clock past round 1's lock locks it`;
  - `moving it past the race scores round 1, and past +48 hours makes it final`.

  For #177: run `pnpm e2e e2e/sign-up.spec.ts` 10 times at 7 workers (`for i in $(seq 10); do pnpm e2e e2e/sign-up.spec.ts --workers=7 || break; done`) and record each failure's test name and step.
- [ ] **Step 2:** Run `pnpm e2e --project=fantasy`. Expected: FAIL (no project).
- [ ] **Step 3:** Implement the project, the routes and the helpers.
- [ ] **Step 4:** Fix #177 from what Step 1 recorded, with proper waits (a hydrated control, a visible countdown, an arrived email), never retries.
- [ ] **Step 5:** Run `pnpm e2e --project=fantasy --workers=1`, then 10 full `pnpm e2e` runs at 7 workers. Expected: all pass. Run `pnpm build` without the flag and check the marker check passes.
- [ ] **Step 6:** Commit: `test: a replay-mode server for the fantasy e2e` (closes #177 as well).

### Task 4: Spoiler state: watch marks and the reveal check

**Files:**
- Create: `src/db/schema/spoilers.ts`, `src/spoilers/reveal.ts`, `src/spoilers/reveal.test.ts`.
- Modify: `src/db/schema/index.ts`, `src/identity/personal-data.ts` (the registry), `src/server/play.ts` (created here), DM 5.7 and 6.7.

**Interfaces:**
- Consumes: `profiles.spoiler_protection`, `sessions.scheduled_start`, `Viewer`.
- Produces:
  - Table `session_watch_marks` as DM 5.7: `(user_id, session_id)` primary key, `marked_at`. `user_id` is `ON DELETE RESTRICT` to `users`; the registry entry is `onDelete: "delete"`, `exportAs: "watched_sessions"`. M5's registry test (`personal-data.test.ts`) fails until it's added.
  - `SPOILER_WINDOW_DAYS = 7`.
  - `isRevealed(input: { sessionStart: Date; now: Date; watched: boolean; protection: boolean }): boolean`, pure: revealed if protection is off, watched, or `now >= sessionStart + 7 days`. A session that hasn't started has nothing to hide and counts as revealed.
  - `type Reader = { userId: string; spoilerProtection: boolean } | null` (null for logged out).
  - `revealedSessions(db, now, reader: Reader, sessionIds: string[]): Promise<Set<string>>`: one query for every id.
  - `markWatched(db, now, { userId, sessionIds }): Promise<void>`: idempotent (`ON CONFLICT DO NOTHING`).
  - Server function `markSessionsWatched({ sessionIds })` in `src/server/play.ts`, `requireWritable`, at most 10 ids. `src/server/play.ts` also gets the shared `playAction` wrapper the later tasks use: Zod input, viewer, `withRequestNow`, `private, no-store`, and `GameError` mapped to `{ ok: false, error }`.

- [ ] **Step 1: Write the failing tests:**
  - `isRevealed`, table-driven: protection off; watched; 6 days 23 hours after the start (hidden); exactly 7 days (revealed); not started;
  - `a logged-out reader sees only sessions past the window`;
  - `one query for many sessions` (a query counter);
  - `marking twice keeps one row`;
  - `a watch mark needs a real user and session`;
  - `the registry covers session_watch_marks` (M5's registry test, now passing);
  - `an export lists watched sessions`, and `deleting an account removes its marks`.
- [ ] **Step 2:** Run `pnpm test src/spoilers src/identity/personal-data.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement, then `pnpm db:generate`.
- [ ] **Step 4:** Run `pnpm test && pnpm db:drift`. Expected: PASS, no drift.
- [ ] **Step 5:** Update DM 5.7 (built in M6) and 6.7 (export and deletion). Commit: `feat: watch marks and the spoiler check`.

### Task 5: The app shell: current game, bottom nav and desktop menu

**Files:**
- Create: `src/play/current-game.ts`, `current-game.test.ts`, `src/components/app-shell.tsx`, `app-shell.test.tsx`, `e2e/fantasy/shell.spec.ts`.
- Modify: `src/routes/__root.tsx`, `src/server/play.ts`, `src/lib/auth-gate.ts` (the new routes' public or private rule), `docs/design/03-ui-brief.md`.

**Interfaces:**
- Consumes: `BottomNav`, `Icon`, `EmptyState`; `getAccount`.
- Produces:
  - `CurrentGame = { id: string; slug: string; name: string; status: "open" | "running"; seasonYear: number }`.
  - `currentGame(db): Promise<CurrentGame | null>`: the `open` or `running` game of the latest season.
  - `<AppShell active>`: the bottom nav under 1024 px (Home, Team, Leagues, Profile), and from 1024 px a side menu with the same items, the wordmark and a main column of at most 1200 px. The footer stays.
  - `<NoGame />`: `EmptyState` "No game yet", "The game opens before the first race."
  - Server function `getCurrentGame()`, cached per request.
  - Route rules in `auth-gate.ts`: `/weekend` and `/prices*` public (decision 3); `/team*` and `/leagues*` send a logged-out visitor to `/sign-in?next=`.

- [ ] **Step 1: Write the failing tests.** `current-game.test.ts`: `none when no game is open or running`; `an open game is current`; `the latest season wins`; `a completed game isn't current`.

  `app-shell.test.tsx`: `the active item has aria-current`; `four items in order`.

  `e2e/fantasy/shell.spec.ts`: at 390×844, `the bottom nav is visible and the side menu isn't`; at 1280×800, `the side menu replaces it`; `a logged-out visitor opening /team goes to sign in and comes back`; `with no game, Team shows No game yet`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test`, `pnpm e2e --project=fantasy --workers=1`. Expected: PASS.
- [ ] **Step 5:** Note in the UI brief that Forum and the bell join in M7. Commit: `feat: the app shell`.

### Task 6: Teams: create, rename and remove

**Files:**
- Create: `src/play/teams.ts`, `teams.test.ts`, `src/routes/team.index.tsx`, `e2e/fantasy/teams.spec.ts`.
- Modify: `src/server/play.ts`, `src/routes/profile.tsx` (its Teams section), `src/server/settings-actions.ts` (`profileState` gains teams).

**Interfaces:**
- Consumes: `createTeam`, `renameTeam`, `removeTeam`, `syncAutoLeagues`, `gamesForAutoLeagues` (Task 1), `currentGame`.
- Produces:
  - `TeamSummary = { id: string; slot: number; name: string; status: "active" | "retired"; locked: boolean }` (`locked`: it has a first event).
  - `myTeams(db, { gameId, userId }): Promise<TeamSummary[]>`, by slot.
  - `createTeamAction(db, now, viewer, { name })`: `createTeam`, then `syncAutoLeagues` with the profile's favorites in the same transaction (finding 2). Returns `{ ok: true, slot } | { ok: false, error }`.
  - `renameTeamAction`, and `removeTeamAction`, which deletes a team that never locked and retires one that did (the M3 rule).
  - `/team`: with no team, `EmptyState` "No team yet" and "Create a team" (name field, 1 to 30 characters). With one, it goes to `/team/1`. With more, a list of up to 3 and "Create a team" while a slot is free. Remove asks first: "Delete this team?" before its first lock, "Retire this team? It leaves every league." after.
  - Profile's Teams section lists names and slots, linking to each.

- [ ] **Step 1: Write the failing tests.** `teams.test.ts`:
  - `a new team joins its auto leagues straight away, in an open game`;
  - `a fourth team is refused with no_free_slot`;
  - `a name of 31 characters is bad_name`;
  - `removing a team before its first lock deletes it; after, retires it`;
  - `someone else's team can't be renamed` (`team_not_owned`);
  - `an impersonated session can't create a team`.

  `e2e/fantasy/teams.spec.ts`: `create a first team and land in its builder`; `a second team shows in the list and on the profile`; `rename and delete`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test src/play`, `pnpm e2e --project=fantasy --workers=1`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: create, rename and remove teams`.

### Task 7: The builder's read and save

**Files:**
- Create: `src/play/builder.ts`, `builder.test.ts`, `src/play/preview.ts`, `preview.test.ts`.
- Modify: `src/server/play.ts`.

**Interfaces:**
- Consumes: `saveLineup`, `priceList`, `playedChips`, `netTransfers`, `freeTransfers`, `transferPenalty`, the SQL functions `team_base_state`, `team_purchasing_power` and `final_fix_window_open`, `driver_availability`, `constructor_seasons.color`, `revealedSessions`.
- Produces:
  - `PoolRow = { assetId; kind: "driver" | "constructor"; title; subtitle; code; color; price: MoneyUnits; delta: MoneyUnits | null; availability: "available" | "doubtful" | "out" | "withdrawn"; inBase: boolean; ownership: number | null }`. `delta` is null when decision 4 hides it.
  - `BuilderState = { team: { id; slot; name }; event: { id; name; round; lockAt: string; raceSessionId: string } | null; phase: "open" | "locked" | "between"; pool: PoolRow[]; latest: { versionId: string; picks: LineupPick[] } | null; base: LineupPick[] | null; purchasingPower: MoneyUnits; freeTransfers: number | null; penaltyPerTransfer: number; squad: { drivers: number; constructors: number }; chips: ChipState[]; limitless: boolean; x3TargetAssetId: string | null; lateCallOpen: boolean; locked: LockedView | null }`.
    - `phase`: `open` while the game has an open event before its lock; `locked` from the lock until the next window opens; `between` when nothing is open (a cancelled-event gap, or the season's end).
    - `ChipState = { code; name; sentence; status: "available" | "played" | "locked_until_first_race" | "used"; playedFor: string | null }`, with our names and one sentence each from the chip sheet board.
    - `LockedView` is Task 9's.
  - `builderState(db, now, { teamId, reader }): Promise<BuilderState>`, where `reader: NonNullable<Reader>` (Task 4): refuses another user's team (`team_not_owned`).
  - `TeamPreview = { spent: MoneyUnits; overBy: MoneyUnits; transfers: number; free: number | null; extra: number; penalty: number; problems: ("drivers" | "constructors" | "boost" | "over_budget" | "x3_target" | "unavailable")[] }`.
  - `previewTeam(state: BuilderState, picks: LineupPick[]): TeamPreview`, pure, built on `netTransfers` and `transferPenalty` so the numbers are the lock job's. With `limitless`, `over_budget` never appears.
  - `saveTeamAction(db, now, viewer, { teamId, picks, basedOnVersionId })`: `{ ok: true; versionId; staleBase: boolean } | { ok: false; error: GameErrorCode }`.
  - Server functions `getBuilder({ slot })` and `saveTeam(...)`.

- [ ] **Step 1: Write the failing tests.** `preview.test.ts` (pure):
  - `a first event has unlimited free transfers and no penalty`;
  - `three changes with two free cost one extra transfer`, at the ruleset's penalty;
  - `with one carried over, three changes are free`;
  - `swapping a driver out and back in is no transfer`;
  - `$101.4M against $100M is over by $1.4M`;
  - `a Blank Cheque week is never over budget`;
  - `four drivers is a drivers problem`, `no Boost or two Boosts is a boost problem`, `a Boost on a constructor is a boost problem`;
  - `dropping the Overdrive target is an x3_target problem`.

  `builder.test.ts` (PGlite, the 2026 game):
  - `before round 1's lock: phase open, every pool asset priced, nothing in base, unlimited transfers`;
  - `after round 1 is final: round 2 open, base is round 1's locked lineup, purchasing power is the bank plus the base at round 2's prices`;
  - `a withdrawn driver shows as withdrawn, and only an owner sees him pickable`;
  - `Hadjar in rounds 12 to 14 is out` (his real absence);
  - `ownership is the share of round 1's locked teams holding each asset`;
  - `the price delta is null while round 1's race is hidden for this viewer` (decision 4);
  - `another user's team is team_not_owned`;
  - `a save returns staleBase when another save came first`;
  - `a save after the lock is window_closed`;
  - `preview agrees with the lock record`: for 20 random lineups (the seeded `random` helper), `previewTeam`'s transfers and penalty match the `team_event_states` row the lock job writes.
- [ ] **Step 2:** Run `pnpm test src/play`. Expected: FAIL.
- [ ] **Step 3:** Implement. One query per part of the state (pool with prices and availability, versions, base state, chips), not one per asset.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: the team builder's read and save`.

### Task 8: Team builder and driver picker screens

**Files:**
- Create: `src/routes/team.$slot.index.tsx`, `src/components/play/team-builder.tsx`, `driver-picker.tsx`, `use-draft.ts`, `use-draft.test.ts`, `team-words.ts`, `team-words.test.ts`, `e2e/fantasy/builder.spec.ts`.
- Modify: `docs/design/03-ui-brief.md` (anything the build changed).

**Interfaces:**
- Consumes: `getBuilder`, `saveTeam`, `previewTeam`, the Task 2 components.
- Produces:
  - The wave 2 boards **Ready to save**, **Over the cap with an extra transfer** and **Pick a replacement driver**, with the canvas's copy:
    - `CountdownBlock` "Locks in" with stats "Bank" and "Transfers" ("1 of 2 free transfers used");
    - `BudgetMeter` against purchasing power;
    - 5 driver rows and 2 constructor rows (`AssetRow`, with the Boost badge), and Save and Chips in a bar fixed above the nav;
    - over the cap, one sentence ("You're $1.4M over the cap. Swap one driver to save.") and a second on the penalty ("One extra transfer: −10 points at the lock."), with Save disabled;
    - an inactive pick shows "Out this race" or "Doubtful" on its row, with a line above the list.
  - **The driver picker** sheet: about 7 rows and "See all 22"; drivers you can't afford stay visible, untinted and disabled with "$0.4M over budget"; a Boost switch on the chosen driver.
  - `useDraft(teamId, eventId)`: `{ picks, setPicks, clear, fromServer: boolean }`, starting from the draft if there is one, else `latest`, else empty.
  - `teamWords(error: GameErrorCode, ctx): string`: wave 2's copy for each refusal, including `window_closed` "Your team locked at 14:00." (the lock in the viewer's time).
  - The toast "Team saved" after a save, and "Your other device saved changes" with "See their team" when `staleBase`.

- [ ] **Step 1: Write the failing tests.** `use-draft.test.ts`: `a draft survives a reload`, `a save clears it`, `no storage still works`. `team-words.test.ts`: one case per code.

  `e2e/fantasy/builder.spec.ts`, at 390×844 on the seeded game:
  - `build a first team: pick 5 drivers and 2 constructors, choose the Boost, save, see Team saved, and reload to the same team`;
  - `over the cap: Save is disabled and the sentence says by how much`;
  - `after round 1 is final, three changes show one extra transfer and its penalty`;
  - `a driver you can't afford is shown, disabled, with how much over`;
  - Review Focus 1: `two pages on one team: the second save says your other device saved changes, and keeps its own draft`;
  - Review Focus 2: `a page opened before the lock, saved after it, says the team locked and keeps the draft`;
  - Review Focus 4: `prices move under an open page: the save is refused with words and the new prices load`;
  - `the whole builder works with the keyboard alone`, `axe finds nothing serious`, in both themes;
  - `Save is disabled until hydrated`.
- [ ] **Step 2:** Run `pnpm e2e e2e/fantasy/builder.spec.ts --project=fantasy --workers=1`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test` and the whole fantasy project. Expected: PASS. Look at each board in both themes at phone size beside the canvas.
- [ ] **Step 5:** Commit: `feat: the team builder and driver picker`.

### Task 9: Chips, Late Call and the locked team

**Files:**
- Create: `src/components/play/chip-sheet.tsx`, `src/components/play/locked-team.tsx`, `e2e/fantasy/chips.spec.ts`, `e2e/fantasy/lock.spec.ts`.
- Modify: `src/play/builder.ts`, `builder.test.ts`, `src/server/play.ts`, `src/routes/team.$slot.index.tsx`.

**Interfaces:**
- Consumes: `playChip`, `saveFinalFix`, `lockedLineup`, `revealedSessions`, `markSessionsWatched`.
- Produces:
  - `playChipAction(db, now, viewer, { teamId, chipCode, targetAssetId? })` and `lateCallAction(db, now, viewer, { teamId, outAssetId, inAssetId })`, each `{ ok: true } | { ok: false, error }`.
  - `LockedView = { picks: LineupPick[]; chip: string | null; sessions: { id; label; revealed: boolean; points: number | null }[]; total: number | null; status: "provisional" | "final" | null }`: points only for revealed sessions, and `total` only when every scored session is revealed.
  - **The chip sheet** (wave 2 board): one row per chip with its sentence; one "Play <name>" at a time with a confirm step ("You can't undo this."), because chips have no undo (DM 3.9). Overdrive asks for its driver first, excluding the Boost driver. Rebuild and Blank Cheque show "From your second race" until unlocked. Late Call shows "Opens after qualifying" until `lateCallOpen`.
  - **The locked team** (wave 2 board "Locked, with qualifying scores hidden"): prices give way to the session scores, each in a `SpoilerCover` with Show it and Mark as watched; the action becomes "Play Late Call" while its window is open, opening the driver picker for one swap.

- [ ] **Step 1: Write the failing tests.** In `builder.test.ts`: `locked view has no points for a hidden session and no total`; `after Mark as watched it has both`; `with spoiler protection off, everything shows`.

  `e2e/fantasy/chips.spec.ts`:
  - `play Overdrive on a driver, see it on the team, and see it can't be played again`;
  - `Overdrive can't go on the Boost driver`;
  - `Rebuild says From your second race in round 1`;
  - `Blank Cheque lets a team over the cap save, and next round it's back to the old team`;
  - `a second chip in the same round is refused with words`.

  `e2e/fantasy/lock.spec.ts`:
  - `at the lock the builder turns to the locked team and Save is gone`;
  - `after qualifying, the score is hidden; Show it reveals it here only; Mark as watched reveals it everywhere`;
  - `Late Call before qualifying says Opens after qualifying; after it, one swap saves and the chip is used`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test src/play` and the fantasy project. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: chips, Late Call and the locked team`.

### Task 10: Home and the weekend hub

**Files:**
- Create: `src/play/weekend.ts`, `weekend.test.ts`, `src/play/home.ts`, `home.test.ts`, `src/routes/weekend.tsx`, `e2e/fantasy/weekend.spec.ts`.
- Modify: `src/routes/index.tsx`, `src/server/play.ts`, `src/lib/auth-gate.ts`.

**Interfaces:**
- Consumes: `currentGame`, `revealedSessions`, `myTeams`, `formatCountdown`. Home's league block is Task 12's: until it lands, `leagues` is always empty and the block is left out.
- Produces:
  - `SessionState = "scheduled" | "tbc" | "live" | "red_flag" | "ended_early" | "cancelled" | "ended"`.
  - `sessionState(s: { status; startConfirmed; start: Date; end: Date }, now: Date): SessionState`, pure (finding 5).
  - `Weekend = { eventId; name; round; lockAt: string; lockSessionId: string; circuitTimeZone: string; sessions: { id; kind; label; start: string; end: string; state: SessionState; locksTeam: boolean; revealed: boolean }[] }`.
  - `weekendFor(db, now, { gameId, reader }): Promise<Weekend | null>`: the open event; else the latest locked one until the next opens; else the next upcoming.
  - `HomeState = { weekend: Weekend | null; season: { teamName; total: number | null; rank: number | null } | null; leagues: LeagueRow[] }`, at most 5 blocks (wave 3): the weekend, the countdown, your season, 3 leagues. The board's "2 hot threads" join in M7.
  - `homeState(db, now, viewer)`. Season total and rank are covered by decision 2's rule.
  - `/weekend`: the wave 3 hub board, sessions in your time with a Track switch, "Locks team" on the locking session, Mark as watched per scored session. Public and cached (decision 3) for a logged-out visitor, who sees no watched state.

- [ ] **Step 1: Write the failing tests.** `weekend.test.ts`:
  - `sessionState`, table-driven over the 7 states, including `a start not confirmed is tbc` and `between start and end is live`;
  - `the open event is the weekend`, `after the lock it stays until the next opens`, `a cancelled event is skipped`;
  - `Locks team is on qualifying, and on sprint qualifying at a sprint weekend`.

  `home.test.ts`: `no team: no season block`; `the season total and rank are null while the last race is hidden`.

  `e2e/fantasy/weekend.spec.ts`:
  - `home in race week shows the weekend, the countdown and your season`;
  - `the hub switches between your time and track time`;
  - `a logged-out visitor sees the hub, with a public cache header and no cookie`;
  - `Mark as watched on the hub reveals the score on the team page`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test src/play` and the fantasy project. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: home and the weekend hub`.

### Task 11: Points breakdown and the driver sheet

**Files:**
- Create: `src/play/breakdown.ts`, `breakdown.test.ts`, `src/play/line-words.ts`, `line-words.test.ts`, `src/routes/team.$slot.points.tsx`, `src/components/play/driver-sheet.tsx`, `e2e/fantasy/breakdown.spec.ts`.
- Modify: `src/server/play.ts`.

**Interfaces:**
- Consumes: `team_base_lines`, `team_adjustment_lines`, `team_event_totals`, `asset_score_lines`, `scoring_runs`, `result_overrides`, `revealedSessions`.
- Produces:
  - `lineWords(ruleCode: string, detail: unknown): string`: one entry per 2026 rule code (`race.position` "P3", `race.positions` "gained 3 places", `race.not_classified` "Not classified", and the rest), joined with " · " on a row.
  - `Breakdown = { event: { id; name; round }; status: "provisional" | "final"; total: number | null; correction: string | null; sessions: { id; label; revealed: boolean; points: number | null; rows: { assetId; title; code; color; points: number; reason: string }[] }[]; extras: { kind: AdjustmentLine["lineType"]; words: string; points: number }[] }`. A hidden session has `points: null` and no rows. `extras` (Boost, Overdrive, Strategist, Safety Car, transfer penalty) hold only lines of revealed sessions, and the event-level penalty only when every session is revealed.
  - `teamBreakdown(db, now, { teamId, reader, round? })`, `reader: NonNullable<Reader>`: the latest scored event by default.
  - `assetSheet(db, now, { gameId, assetId, eventId, reader })`: the driver sheet's lines per revealed session, line by line.
  - The wave 3 boards "One weekend, by session, with a correction note" (session `Tabs`, one row per asset with one number and a plain reason, boosts and the penalty in their own section, `PointsPill` with Provisional or Final) and "Driver points line by line" (a `Sheet`).
  - `correctionNote(...)`: the sentences in My calls.

- [ ] **Step 1: Write the failing tests.** `line-words.test.ts`: one case per rule code in `SCORING_RULES_2026`, and `an unknown code throws` (so a new rule can't ship without words).

  `breakdown.test.ts` (the 2026 replay):
  - `base rows plus extras add up to the stored total`, for every scripted team at 3 events;
  - `a hidden qualifying session has no rows and no points, and the total is null`;
  - Review Focus 3: `the response carries no figure for a hidden session`, by searching the serialized object for the session's real points;
  - `a stewards' change shows its correction note`, from the replay's `lateStewardsPenalty`;
  - `a provisional event says provisional`;
  - `the driver sheet's lines add up to the row`.

  `e2e/fantasy/breakdown.spec.ts`: `open the breakdown from the team, switch sessions, open a driver's sheet`; `a hidden session shows the cover until revealed`; `the page title doesn't name a result`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test` and the fantasy project. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: the points breakdown and driver sheet`.

### Task 12: Leagues: mine, create, join and leave

**Files:**
- Create: `src/play/leagues.ts`, `leagues.test.ts`, `src/routes/leagues.index.tsx`, `leagues.new.tsx`, `src/components/play/join-sheet.tsx`, `e2e/fantasy/leagues.spec.ts`.
- Modify: `src/server/play.ts`, `src/settings/defaults.ts`, `src/game/errors.ts` (`rate_limited`), `src/play/home.ts` and `src/routes/index.tsx` (home's league block, 3 leagues).

**Interfaces:**
- Consumes: `createLeague`, `joinLeague`, `leaveLeague`, `consumeRateLimit`, `myTeams`, `HomeState` (Task 10).
- Produces:
  - Setting `league_join_limit: { windowSeconds: 600, max: 10 }`.
  - `LeagueRow = { leagueId; slug; name; kind; teamName; rank: number | null; members: number }`.
  - `myLeagues(db, now, { gameId, userId, reader }): Promise<{ yours: LeagueRow[]; automatic: LeagueRow[] }>`: the global league first in `automatic`; `rank` null under decision 2's rule.
  - `createLeagueAction(db, now, viewer, { teamId, name, kind, startRound?, endRound? })`: rounds become sequences, then `createLeague` and `joinLeague` with the owner's chosen team in one transaction. Returns `{ ok: true; slug; joinCode }`.
  - `joinLeagueAction(db, now, viewer, { code, teamId })`: `consumeRateLimit` on `league_join:<userId>` first; over it, `{ ok: false, error: "rate_limited" }` (a new `GameErrorCode`). Then `joinLeague`.
  - `leaveLeagueAction(db, now, viewer, { leagueId, teamId })`.
  - The wave 3 boards "My leagues (yours and automatic)", "Create a league (mini-league range)" (All races, or Some races with From and To rounds) and "Join with a code" (a sheet: the code, then which team, when there's more than one). After creating, the code shows with a Copy button.

- [ ] **Step 1: Write the failing tests.** `leagues.test.ts`:
  - `a new team appears in Global and its auto leagues`;
  - `create a mini-league for rounds 5 to 9: its range is those events' sequences, and the owner's team is in it`;
  - `rounds out of order are refused`;
  - `join with a code in lower case and spaces`;
  - Review Focus 5: `the 11th try in 10 minutes is rate_limited, even with a right code`; `a wrong code and another game's code both read league_not_found`;
  - `a team in 50 leagues gets league_cap`;
  - `leaving an auto league is league_not_found`.

  `e2e/fantasy/leagues.spec.ts`: `create a private league, copy its code, and a second account joins with it`; `a user with two teams chooses which joins`; `leave a league`; `axe finds nothing serious`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test` and the fantasy project. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: leagues: create, join and leave`.

### Task 13: Standings

**Files:**
- Create: `src/play/standings.ts`, `standings.test.ts`, `src/routes/leagues.$slug.tsx`, `e2e/fantasy/standings.spec.ts`.
- Modify: `src/play/leagues.ts`, `src/server/play.ts`.

**Interfaces:**
- Consumes: `league_standings`, `team_event_totals.global_rank`, `revealedSessions`.
- Produces:
  - `StandingsPage = { league: { name; kind; range: string | null }; through: { round; name } | null; status: "provisional" | "final" | null; hidden: boolean; rows: { rank; move: number | null; teamName; username: string | null; points; mine: boolean }[]; next: number | null; tiebreak: string }`. With `hidden`, `rows` is empty and `next` null (decision 2). A deleted user's team shows as "Deleted team" with no username.
  - `standingsPage(db, now, { gameId, slug, reader, afterRank?: number, limit = 50 })`: keyset paging (`rank > afterRank ORDER BY rank`), which DM 4.7 checked reads the index. `global` reads `team_event_totals` at the latest event with totals.
  - `tiebreak`: "Teams on the same points are split by who got there first." (wave 3), plus the range for a mini-league ("Counts rounds 5 to 9 only.").
  - Your row is outlined, and "▲3" or "▼1" comes from `previous_rank`.
  - From 1024 px, the wave 3 desktop board: a real table, and a side card with your position.

- [ ] **Step 1: Write the failing tests.** `standings.test.ts`:
  - `pages of 50 meet without a gap or a repeat`, on a league of 120 teams;
  - `shared ranks show once each and the next rank skips`;
  - `the move is previous minus current`;
  - Review Focus 3: `while the last race is hidden, no rank, points or move is returned`;
  - `a mini-league's note names its rounds`;
  - `a deleted user's team reads Deleted team`.

  `e2e/fantasy/standings.spec.ts`: `a league's standings after round 1 show your team outlined`; `See more loads the next page`; `the table is a real table at desktop width`; `hidden until the race is watched`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test` and the fantasy project. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: league standings`.

### Task 14: Prices and How prices work

**Files:**
- Create: `src/play/prices.ts`, `prices.test.ts`, `src/routes/prices.index.tsx`, `prices.how.tsx`, `e2e/fantasy/prices.spec.ts`.
- Modify: `src/server/play.ts`, `src/lib/auth-gate.ts`.

**Interfaces:**
- Consumes: `priceList`, `price_update_runs.inputs`, the ruleset's `prices.formula`, `priceChange`, `revealedSessions`.
- Produces:
  - `PriceBoard = { event: { round; name }; changesFrom: { round; raceSessionId } | null; changesHidden: boolean; up: PriceRow[]; down: PriceRow[]; all: PriceRow[]; teamValue: { now: MoneyUnits; change: MoneyUnits | null } | null }`, where `PriceRow = { assetId; title; code; color; price: MoneyUnits; change: MoneyUnits | null; ownership: number | null }`. With `changesHidden`, every `change` is null and `up` and `down` are empty (decision 4).
  - `priceBoard(db, now, { gameId, reader, userId?, show?: "changes" })`. `show` reveals the changes for a logged-out visitor on the separately cached `/prices?show=changes`.
  - `howPricesWork(params)`: the formula's steps in plain words, from the ruleset version in force, and one worked example computed by `priceChange` on made-up points, labelled "Example numbers" (wave 3).
  - The wave 3 boards "Price changes (going up / going down, your team value)" and "How prices work". Team value reads in words: "Up $1.0M since last race."

- [ ] **Step 1: Write the failing tests.** `prices.test.ts`:
  - `after round 1's update, up and down match the run's changes`;
  - Review Focus 3: `a viewer who hasn't watched round 1's race gets no change figures`, and `?show=changes gives them to a logged-out visitor`;
  - `team value is the base lineup at the current prices plus the bank`;
  - `the worked example agrees with priceChange`;
  - `the steps read the version's thresholds, not constants in the page`.

  `e2e/fantasy/prices.spec.ts`: `going up and going down tabs`; `How prices work opens from Prices`; `a logged-out visitor gets a public cache header and covered changes`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test` and the fantasy project. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: prices and how prices work`.

### Task 15: The exit: every flow, both themes, and staging

**Files:**
- Create: `e2e/fantasy/season.spec.ts`.
- Modify: `docs/design/04-implementation-plan.md` (M6's result), `docs/design/03-ui-brief.md`, `README.md` (the fantasy e2e project).

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the season walk-through.** `e2e/fantasy/season.spec.ts`, one person at phone size from sign-up: create a team, build it, play Overdrive, join a friend's league, the lock, a hidden qualifying score, Mark as watched, the breakdown, Late Call after qualifying, standings after the race, prices after the update, and round 2 with its transfers. This is the roadmap's key-test list in one run.
- [ ] **Step 2:** Run `pnpm test`, `pnpm lint`, `pnpm typecheck`, `pnpm e2e` and `pnpm e2e --project=fantasy --workers=1`. Expected: PASS.
- [ ] **Step 3:** Run axe on every new screen in both themes, and check every screen at 390 px and 1280 px against the canvases. Record what differs in the UI brief.
- [ ] **Step 4:** Check the scenario table below: every row names a passing test or a later milestone.
- [ ] **Step 5:** Request the whole-milestone review (superpowers:requesting-code-review) and fix what it finds in one PR, as M5 did.
- [ ] **Step 6:** **With your OK, and not on a race weekend,** run Deploy staging. Expected: Task 4's migration applies, the tick keeps its triggers, and the screens answer on the staging address with their empty states. Check one fantasy server-function POST there (the CSRF Origin check M9 also wants).
- [ ] **Step 7:** Record the result in the roadmap's M6 section with the run ids. Commit: `docs: M6's result`.

## Scenario coverage (UI waves 2–3 and the roadmap's key tests)
| Board, state or key test | Where it's proved |
|---|---|
| Team builder: ready to save | 7, 8 |
| Team builder: over the cap with an extra transfer | 7: `previewTeam` · 8 |
| Driver picker, unaffordable and out-this-race rows | 7: availability · 8 |
| Chip sheet; one chip per race; no undo | 9 |
| Locked, with qualifying scores hidden | 9 |
| Save conflict ("your other device saved changes") | 7: `staleBase` · 8 |
| Inactive-driver warnings | 7, 8 |
| Lock countdown | 2: `CountdownBlock` · 8, 10 |
| **Key test: building a team** | 8, 15 |
| **Key test: the lock** | 9, 15 |
| **Key test: chips** | 9, 15 |
| Home in race week | 10. Hot threads: **M7** |
| Weekend hub, your time or track time | 10 |
| Session row states | 10. "Delayed": **M8** (finding 5) |
| Points breakdown by session, with a correction note | 11 |
| **Key test: the breakdown** | 11, 15 |
| Driver points line by line | 11 |
| My leagues, create (mini-league range), join with a code | 12 |
| **Key test: joining a league** | 12, 15 |
| Standings with the tiebreak explained, paged | 13 |
| Price changes, team value, How prices work | 14 |
| Desktop shell and the standings table | 5, 13 |
| **Key test: spoiler-gated scores** | 4, 9, 10, 11, 13, 14, 15 |
| Weekend hub with qualifying not watched (wave 2 spoiler row) | 10 |
| Qualifying thread hidden until watched | **M7** (threads) |
| Logged-out visitors spoiler-safe | 3's public pages · 10, 14. The reveal toggle: **M7** |
| Carried from M5: #177, toast, `updateProfile`'s lock and rollback, trust with games | 3, 2, 1, 1 |

## Not in M6
- Threads, chat, notifications and the bell, and the logged-out reveal toggle (M7).
- Staff screens: lock times, prices, the review queue (M8). Admin prices still go through `pnpm staff`.
- Offline (PWA) and the "service paused" page (M9).
- The 2027 game, its calendar and prices (M10).
- League admin beyond creating: renaming, removing members, reassigning a deleted owner's league (left to build time in wave 5, so M8).

## After approval
1. One task issue per task, as sub-issues of #7, with the board fields set.
2. The roadmap's M6 section gains this plan's link, decision 5's exit, and (with decision 1) `session_watch_marks` moving from M7 to M6.

Work starts on Task 1 when you say so, with Tasks 2, 3 and 4 alongside it if you like. Nothing is built yet.
