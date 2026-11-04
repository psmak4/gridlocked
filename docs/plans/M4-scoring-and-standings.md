# M4 Scoring and Standings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** every point is right and explainable, and corrections ripple through (roadmap M4).

**Exit:**
- the full 2026 replay produces totals for scripted teams;
- a manual cross-check against the official game for 3 sampled races matches, after removing the excluded categories (HLD §12).

**Architecture:**
- **The scoring engine is a new module, `src/scoring/`, with no I/O** (HLD §3.2). It turns a ruleset, a session's effective results and the pool into asset score lines. A lint rule keeps `@/db`, `drizzle-orm` and `node:*` out of it.
- **Team adjustments are pure functions in the game module** (`src/game/adjustments.ts`), like `transfers.ts`. They cover Boost, the x3 Boost, Strategist (Autopilot), Safety Car (No Negative) and the transfer penalty.
- **The ledger, the totals and the price formula live in `src/game/`. Leagues and standings get their own module, `src/leagues/`** (HLD §3.2).
- **Base lines and asset totals are SQL views,** so they can't drift from the asset lines (DM 4.0, option C).
- **Two new job kinds run on the existing scheduler tick:**
  - `score_session` runs one scoring run in steps: assets, then teams in batches, then standings;
  - `game_finalize` makes an event's scores final, runs the price update for the next event, and marks the game event `final`.

  The results pipeline enqueues them, and every run is keyed and fingerprinted, so a repeat is free (HLD §3.3 rule 4).
- **No screens, sign-in or notifications.** Those come in M5 and M6. M4 is functions, the database, jobs and the replay.

**Tech Stack:** TypeScript strict, Drizzle, Postgres (PGlite in tests, Neon in staging), Zod, Vitest. No new dependencies: the property tests use a small seeded generator in `tests/helpers/random.ts`.

**Spec:**
- [02-data-model.md](../design/02-data-model.md) Part 4 (4.0–4.13), and 3.2, 3.3, 3.5, 3.7 and 3.9;
- [01-high-level-design.md](../design/01-high-level-design.md) §3.2, §3.3, §5.1, §5.4–§5.6, §6, §8.1 and §12;
- [04-implementation-plan.md](../design/04-implementation-plan.md) M4;
- **the scoring tables of the original brief**, copied verbatim into Task 1's `SCORING_RULES_2026`. HLD §6 checked them against the official rules, apart from the excluded categories: overtakes, Driver of the Day and constructor pit stops.

## Decisions (for approval)
The spec leaves three things open that change what gets built or when M4 can finish.

1. **The 2026 season isn't over, so the full replay can't run yet.** Rounds 20–23 run from 8 Nov to 6 Dec, and the fixtures hold results for only 9 rounds.
   - **Recommended:** record the Jolpica qualifying, sprint and race results for rounds 1–19 now. That's about 45 files, around 1.2 MB. Add each later round after its +48h finalize. The exit run happens after Abu Dhabi is final (8 Dec), well before the 23 Dec target. Tasks 1–9 don't wait for it.
   - **Alternative:** exit on rounds 1–19 and call it "the season to date". That's sooner, but the exit wouldn't be the full season the roadmap names.
2. **What the price formula is calibrated against.** DM 3.5 says the spread of weekly changes "should look like the official game's".
   - **Recommended:** I read the official game's 2026 price history for a sample of about 10 drivers and 4 constructors in the browser pane. Then I tune the formula's tier thresholds so the replay's weekly changes have a similar spread (how often each tier happens, and the biggest weekly move). Only summary numbers go in the repo, never the official tables. If the history isn't visible without signing in, I fall back to the second option and tell you.
   - **Alternative:** pick the tiers ourselves (±$0.1M and ±$0.3M for expensive assets, ±$0.2M and ±$0.6M for cheap ones, as DM 3.5's example) and only check that nothing gets stuck at a bound. That's faster, but less like the official game.
3. **Who does the official cross-check, and for which races.**
   - **Recommended:** I do it in the browser pane. The races are round 1 (Australia, a normal weekend), round 2 (China, a sprint weekend) and round 13 (Italy, during the Hadjar, Lawson and Tsunoda substitution). If the official points pages need signing in, you sign in in the pane and I take it from there (I never enter credentials). As with prices, only matched or differing counts and the explained differences go in the repo.
   - **Alternative:** you read the official numbers yourself and paste them in.

**My calls (lower stakes; each is noted in DM Part 4 when its task lands):**
- **A session under review isn't scored.** Its last scores stay as they were, and stay provisional, until an admin resolves it. That's the brief's "hold affected scoring as provisional until reviewed". Only `provisional` and `final` sessions are scored.
- **An unclassified driver gets only the penalty.** That means no finish-position points, no positions gained or lost, and no fastest lap. This reads HLD §6's "they receive only the NC penalty" literally.
- **A disqualified driver costs their constructor twice:** once inside the drivers' aggregate, and once as the per-driver DSQ line. That's how the brief's tables read ("combined total of both drivers; disqualified driver -20 per driver"). The cross-check checks it if a sampled race has a DSQ.
- **Safety Car floors each category of each asset per session.** A constructor is one asset, so its category subtotal (both drivers together) is what gets floored. The Boost then doubles the floored score, so a Boost never makes a floored category negative again.
- **Strategist (Autopilot) ties:** the original Boost stays if it's among the tied drivers. Otherwise the higher-priced driver gets it, then the lower asset id. The price is the event's price. This is DM 4.3's rule, made deterministic.
- **Asset lines are stored only when they're not zero.** The explanation shows the position in `detail`, and a zero line explains nothing.
- **Notifications (DM 4.8 step 5) wait for M5's email outbox and M6's screens.** M4 stores each run's `diff_summary`, which they will read.
- **The join-code rate limit comes with M5's sign-in endpoints.** M4 builds random codes of at least 8 characters, and the lookup.
- **Auto leagues are created the first time a team joins one.** M5's profile calls `syncAutoLeagues`.
- **A correction version changes scoring only.** It re-points past game events to fix points. Their lock records (transfers and penalties) stay as they were locked.
- **Pruning unlocked lineup versions** (DM 3.7: 7 days after `final`) runs in the daily calendar sync. It was moved here from M3.

## Global Constraints
- **No direct time.** Every function takes `now: Date` from its caller (HLD decision 20). Triggers use `app_now()`. Tests move time with `setSimulatedClock`.
- **Points are integers.** Money is `MoneyUnits` ($0.1M), and prices are `30`–`340`.
- **Layers don't mix.** `src/scoring/` imports nothing with I/O. `src/game/` and `src/leagues/` read results only through the `effective_results` view, and never write results or reference data.
- **Every admin change is audited** in the same transaction (`writeAudit`, `StaffActor`), with a reason that isn't blank. This covers correction versions, re-pointing events, approving a re-score and running a dry run.
- **Migrations:**
  - schema goes in `src/db/schema/scoring.ts` and `src/db/schema/leagues.ts` (plus `price_update_runs` in `game.ts`), then `pnpm db:generate`;
  - triggers, functions and views go in the custom migrations `ledger_rules` and `league_rules`, plus `game_rules_10` for changes to M3's functions. A later task appends to a migration while it's unmerged, and adds `ledger_rules_2` and so on after it has merged. Each `CREATE OR REPLACE` keeps every earlier rule;
  - `pnpm db:drift` stays clean.
- **No new dependencies, and no cloud resources.** Recording fixtures reads Jolpica's public API through the existing rate-limited client. Nothing in M4 needs a staging deploy.
- **The official game's numbers stay out of the repo** (HLD §12: the cross-check is internal). Only match counts, explained differences and summary statistics go in.
- **Workflow:** one branch `m4/<issue>-<slug>` and one PR per task, closing its issue. CI must be green before merge: lint with zero warnings, format, typecheck, `db:check`, `db:drift`, the full Vitest suite and CodeQL.

## Review Focus
1. **A stewards' correction to round 5 lands after round 7 is scored.** Expected: round 5's lines, totals and ranks change; rounds 6 and 7 keep their own points, but their running totals, `first_reached_sequence`, global ranks and league tables all move. *Pinned in Task 5 and Task 10.*
2. **Two runs for one session, started a minute apart, with their steps interleaved.** Expected: the later run's lines are what's stored, the earlier one ends `superseded`, and no batch writes lines from both. *Pinned in Task 4.*
3. **A correction puts a scored session under review.** Expected: no new run; the old scores stay, provisional; resolving the review runs scoring once. *Pinned in Task 8.*
4. **Event E finalizes after E+1 has already opened at the 24-hour cutoff.** Expected: no price update is applied to E+1, whose carried prices stay fixed; a warning review item says so; E still becomes `final`. *Pinned in Task 8.*
5. **A Late Call team whose qualifying result is corrected after the race.** Expected: the qualifying base lines use the locked lineup, the race uses the Late Call lineup, and the Boost stays on the incoming driver for the race only. *Pinned in Task 3 and Task 5.*

---

### Task 1: The 2026 scoring rules as data

**Files:**
- Create:
  - `src/scoring/rules.ts`, `src/scoring/rules.test.ts`;
  - `tests/helpers/random.ts` (the seeded generator: `seededRandom(seed: number): () => number`, mulberry32).
- Modify:
  - `src/game/ruleset.ts`: the `prices.formula` and `autopilot` params;
  - `src/game/games.ts`: `createGame` takes `rules`;
  - `tests/helpers/game-2026.ts`: `seedGame2026` passes `SCORING_RULES_2026`;
  - `eslint.config.mjs`: the `src/scoring/**` import ban;
  - DM 3.2, for the 2026 rows.

**Interfaces:**
- Produces:
  - **The per-kind parameter schemas,** each `z.strictObject`, as one discriminated union `scoringRuleSchema` over `kind`:
    - `position_table`: `{ points: number[] }`. Index 0 is P1, and a position past the end scores 0. Classified rows only.
    - `positions_delta`: `{ perPosition: number, lostCap: number | null }`. Starting grid against the classification; a pit-lane start is last on the grid (the count of the session's result rows). Classified rows only.
    - `classification_penalty`: `{ points: number, classifications: Classification[], noTime: boolean, absent: boolean }`. `noTime` also fires on a null `q1_ms`; `absent` fires on a pool driver with no result row.
    - `flag_bonus`: `{ points: number, flag: "fastest_lap" }`. Fires on `fastest_lap_rank = 1`, classified rows only.
    - `knockout_stage`: `{ noneQ2: number, oneQ2: number, bothQ2: number, oneQ3: number, bothQ3: number }`. Only the highest tier that applies scores. A driver reaches Q2 at a position of `knockout.q2From` or better, and Q3 at `q3From` or better, never by whether a time exists (HLD §5.6).
    - `per_driver_penalty`: `{ points: number, classifications: Classification[] }`.
    - `aggregate_drivers`: `{}`.
  - **`type ScoringRule = { code, sessionKind, target, kind, category, params, sortOrder }`.**
  - **`SCORING_RULES_2026: ScoringRule[]`,** from the brief. `NC` means `not_classified`, `did_not_start` and `excluded`, and DSQ means `disqualified`. In qualifying, NC also covers `did_not_qualify`.

    | code | target | kind | category | params |
    |---|---|---|---|---|
    | `qualifying.position` | driver | position_table | `qualifying_position` | 10, 9, …, 1 |
    | `qualifying.not_classified` | driver | classification_penalty | `qualifying_penalty` | -5; NC and DSQ; noTime; absent |
    | `qualifying.drivers` | constructor | aggregate_drivers | `qualifying_drivers` | |
    | `qualifying.knockout` | constructor | knockout_stage | `qualifying_knockout` | -1, 1, 3, 5, 10 |
    | `qualifying.disqualified` | constructor | per_driver_penalty | `qualifying_penalty` | -5; DSQ |
    | `sprint.positions` | driver | positions_delta | `sprint_positions` | 1; lostCap -10 |
    | `sprint.fastest_lap` | driver | flag_bonus | `sprint_fastest_lap` | 5 |
    | `sprint.position` | driver | position_table | `sprint_position` | 8, 7, …, 1 |
    | `sprint.not_classified` | driver | classification_penalty | `sprint_penalty` | -10; NC and DSQ; absent |
    | `sprint.drivers` | constructor | aggregate_drivers | `sprint_drivers` | |
    | `sprint.disqualified` | constructor | per_driver_penalty | `sprint_penalty` | -10; DSQ |
    | `race.positions` | driver | positions_delta | `race_positions` | 1; no cap |
    | `race.fastest_lap` | driver | flag_bonus | `race_fastest_lap` | 10 |
    | `race.position` | driver | position_table | `race_position` | 25, 18, 15, 12, 10, 8, 6, 4, 2, 1 |
    | `race.not_classified` | driver | classification_penalty | `race_penalty` | -20; NC and DSQ; absent |
    | `race.drivers` | constructor | aggregate_drivers | `race_drivers` | |
    | `race.disqualified` | constructor | per_driver_penalty | `race_penalty` | -20; DSQ |

    No position table is longer than 10, and nothing hard-codes 22 cars.
  - **New ruleset params:**
    - `autopilot: { tiebreak: "original_then_price" }`;
    - `prices.formula: { window: 3, pointsPerMillion: { driver, constructor }, bandSplit: 185, thresholds: { poor, good, great }, changes: { expensive: [t, p, g, gr], cheap: [t, p, g, gr] } }`. The 2026 starting values are `pointsPerMillion` 1.0 for both, `thresholds` 0.6, 1.0 and 1.5, `expensive` -3, -1, 1, 3, and `cheap` -6, -2, 2, 6. Task 10 calibrates them.
  - `createGame(…, { …, rules: ScoringRule[] })` inserts the rules with version 1, validated by `scoringRuleSchema`.

- [ ] **Step 1: Write the failing tests** (`rules.test.ts`):
  - `SCORING_RULES_2026 parses`, with exactly the 17 codes above;
  - `an unknown param key is refused`;
  - `a constructor-only kind on a driver rule is refused`: `knockout_stage`, `per_driver_penalty` and `aggregate_drivers` need `target: "constructor"`;
  - `codes are unique within a ruleset`;
  - `RULESET_2026 with the formula params parses`, and `thresholds out of order are refused`.
  - In `games.test.ts`: `createGame stores the 2026 rules with version 1`.
- [ ] **Step 2:** Run `pnpm test src/scoring src/game/games.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Add the lint rule, and check that it fires by adding a `@/db` import to `src/scoring/rules.ts` and running `pnpm lint` (then remove the import).
- [ ] **Step 4:** Run `pnpm test`, `pnpm lint` and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5:** Update DM 3.2: the 2026 rows and the new params. Commit: `feat: the 2026 scoring rules as data`.

### Task 2: The scoring engine

**Files:**
- Create: `src/scoring/engine.ts`, `src/scoring/engine.test.ts`, `src/scoring/engine.property.test.ts`.

**Interfaces:**
- Consumes: `ScoringRule`, `SCORING_RULES_2026` (Task 1). The engine defines its own input types and imports nothing from `src/db`; Task 4 maps `effective_results` rows onto them.
- Produces:
  - `scoreSession(input: SessionInput): AssetLine[]`, which is pure and deterministic. The output is sorted by asset id, then the rule's `sortOrder`, then `subjectDriverId`.
  - `interface SessionInput { sessionKind: "qualifying" | "sprint" | "race"; rules: ScoringRule[]; knockout: { q2From: number; q3From: number }; results: ResultFact[]; pool: PoolEntry[] }`:
    - `ResultFact` is the subset of an effective result the engine reads: `driverId`, `constructorId`, `position`, `classification`, `grid`, `pitLaneStart`, `fastestLapRank` and `q1Ms`;
    - `PoolEntry` is `{ assetId, assetType, driverId | null, constructorId | null }`, for every pool asset added at or before the event, withdrawn ones included. Owners of a withdrawn asset still take its penalties (DM 3.4).
  - `interface AssetLine { assetId: string; ruleCode: string; category: string; subjectDriverId: string | null; points: number; detail: Record<string, unknown> }`.
  - **How it works (DM 4.2):**
    - it scores **every driver in the results**;
    - a pool driver gets lines for their own driver rules;
    - a pool driver with no result row gets only the `absent` penalty lines;
    - a constructor gets one line per driver rule per driver whose result row names it, with that driver as `subjectDriverId` and the driver rule's code and category, plus its own constructor lines;
    - a driver who isn't in the pool has no lines of their own.

- [ ] **Step 1: Write the failing golden tests** (`engine.test.ts`). Each builds a small session by hand and asserts the exact lines:
  - **Qualifying:**
    - `qualifying P1 scores 10, P10 scores 1 and P11 scores nothing`;
    - `no time set in qualifying scores -5`: classified, `q1Ms` null;
    - `a qualifying DSQ scores -5 and no position points`;
    - `an inactive pool driver with no qualifying row scores -5`;
    - `the knockout tiers`: positions 17 and 18 give -1; 12 and 17 give +1; 12 and 14 give +3; 8 and 14 give +5; 8 and 19 give +5; 3 and 9 give +10;
    - `a Q3 driver with no Q3 time still counts as reaching Q3`: position 9, `q3` null, so +10 with a P4 teammate;
    - `a qualifying DSQ costs the constructor -5 twice`: once in the aggregate, once per driver.
  - **Sprint:**
    - `P10 to P3 in the sprint scores +7 and 6`;
    - `sprint positions lost are capped at -10`: P5 to P20 scores -10;
    - `the sprint fastest lap scores +5`;
    - `a sprint NC scores -10, with no positions lost and no fastest lap`, even with `fastestLapRank` 1;
    - `a sprint DSQ costs the constructor -10 twice`.
  - **Race:**
    - `P1 from P1 scores 25`, and `P2 from P10 scores +8 and 18`;
    - `race positions lost aren't capped`: P3 to P19 scores -16;
    - `the race fastest lap scores +10`;
    - `a race NC scores -20 only`;
    - `a DNS and a withdrawn (W) driver score -20`;
    - `a pit-lane start counts as last on the grid`: 22 rows, a pit-lane start finishing P15 scores +7 (synthetic, since 2026 had none);
    - `DSQ, NC and W are told apart`: DSQ adds the constructor's per-driver line, the others don't.
  - **Roster changes (HLD §8.1):**
    - `a substitute who isn't in the pool scores inside his constructor's aggregate`;
    - `a driver scores for the car he drove`: a Lawson-at-Red-Bull row puts his points in Red Bull's aggregate;
    - `an absent pool driver adds nothing to any constructor`.
  - `zero lines aren't returned`.
- [ ] **Step 2: Write the failing property tests** (`engine.property.test.ts`). Each runs 500 random sessions from `seededRandom(2026)`: 18 to 24 drivers, random classifications, grids and pool membership.
  - `a constructor's points equal its drivers' driver points plus its own constructor lines`;
  - `shuffling the results gives the same lines`;
  - `only pool assets have lines`;
  - `every absent pool driver has exactly the absent penalty`.
- [ ] **Step 3:** Run `pnpm test src/scoring`. Expected: FAIL.
- [ ] **Step 4:** Implement `src/scoring/engine.ts`. One function per `kind`, chosen with an exhaustive `switch`.
- [ ] **Step 5:** Run `pnpm test src/scoring && pnpm lint`. Expected: PASS. Commit: `feat: the scoring engine`.

### Task 3: Team adjustments

**Files:**
- Create: `src/game/adjustments.ts`, `src/game/adjustments.test.ts`.

**Interfaces:**
- Consumes: `AssetLine` (Task 2); the chip effects in `src/game/ruleset.ts`.
- Produces:
  - `teamAdjustments(input: TeamEventInput): AdjustmentLine[]`, pure, in a fixed order.
  - `interface TeamEventInput`:
    - `sessions: { sessionId; kind; order: number }[]`, the event's scored sessions so far;
    - `assetPoints: Map<sessionId, Map<assetId, { total: number; byCategory: Record<string, number> }>>`;
    - `locked: Pick[]`, and `finalFix: { picks: Pick[]; fromSessionId: string } | null`. `Pick` is `{ assetId, assetType, isBoost }`;
    - `chip: { effect: ChipEffect; targetAssetId: string | null } | null`;
    - `transferPenalty: number`;
    - `prices: Map<assetId, number>`, the event's prices, for the Strategist tiebreak.
  - `interface AdjustmentLine { sessionId: string | null; assetId: string | null; lineType: "boost" | "triple_boost" | "autopilot_remove" | "autopilot_add" | "no_negative" | "transfer_penalty"; category: string | null; points: number }`.
  - `effectiveLineup(input, sessionId): Pick[]`. For the race session, it's the Late Call picks when there are any; otherwise the locked picks (DM 4.3). Task 4's view implements the same rule in SQL.
  - **How each line is calculated (DM 4.3 and the calls above):**
    - `boost`: +1× the Boost driver's session points, per session;
    - `triple_boost`: +2× the target's points, per session;
    - `autopilot_remove` and `autopilot_add`: event-level, `sessionId` null. Over the scored sessions so far, the driver with the most event points gets the Boost. If that isn't the chosen Boost driver, `remove` takes back the chosen driver's Boost lines, and `add` gives the leader the same number of points they scored;
    - `no_negative`: per session, asset and category with a negative subtotal, it adds back exactly that amount. With Safety Car, the Boost line doubles the floored total;
    - `transfer_penalty`: event-level, copied when it isn't 0.
  - No zero lines.

- [ ] **Step 1: Write the failing tests:**
  - `Boost adds the Boost driver's points again, per session`;
  - `Overdrive adds twice the target's points, and the Boost still applies to its own driver`;
  - `Strategist moves the Boost to the top scorer as a remove and add pair`;
  - `Strategist adds nothing when the chosen driver leads`;
  - `a Strategist tie keeps the original Boost`;
  - `a Strategist tie without the original goes to the higher price, then the lower asset id`;
  - `Strategist is recomputed as sessions are scored`: the leader after qualifying differs from the leader after the race;
  - `Safety Car floors each negative category, per asset and session`: race positions -5 and finish +10 gives +5 back for positions only;
  - `Safety Car floors a constructor's category subtotal, not each driver's`;
  - `Safety Car doesn't floor the transfer penalty`;
  - `with Safety Car, the Boost doubles the floored score`;
  - `Late Call: qualifying uses the locked lineup and the race the Late Call one`;
  - `Late Call: the Boost moves to the incoming driver for the race only`;
  - `the transfer penalty is one event-level line`;
  - a property test with `seededRandom(4)`, 300 cases: `base points plus adjustments equal a straightforward recount`, using a test-only reference implementation in the test file.
- [ ] **Step 2:** Run `pnpm test src/game/adjustments.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run it again. Expected: PASS. Commit: `feat: team adjustments for Boost and chips`.

### Task 4: Scoring runs and the ledger

**Files:**
- Create:
  - `src/db/schema/scoring.ts`: `scoring_runs`, `asset_score_lines`, `team_adjustment_lines`, and typed `.existing()` handles for the views;
  - the generated migration, and the custom `ledger_rules` migration (the views `asset_session_totals` and `team_base_lines`);
  - `src/game/scoring-runs.ts`, `src/game/scoring-runs.test.ts`.
- Modify: `src/db/schema/index.ts`.

**Interfaces:**
- Consumes: `scoreSession` (Task 2), `teamAdjustments` and `effectiveLineup` (Task 3); `lockedLineups`, `playedChips`, and `team_event_states`.
- Produces:
  - **The schema, as DM 4.1–4.3 says.** That includes the partial unique index of one current run per `(game_id, session_id)`, the unique line key of DM 4.2, and the indexes of DM 4.10.
  - **The views:**
    - `asset_session_totals` gives `(game_id, session_id, asset_id, points, by_category jsonb)`;
    - `team_base_lines` gives `(game_id, team_id, event_id, session_id, asset_id, points)`. Its lineup is the locked version, or for the race session the Late Call version, through `team_event_states.final_fix_version_id`.
  - `ENGINE_VERSION = "2026.1"`, in `src/scoring/engine.ts`.
  - `startRun(db, now, { gameId, sessionId, trigger, mode }): Promise<{ runId: string } | { skipped: true }>`:
    - it reads the inputs: the session's `effective_results`, its `game_session_exceptions` row, the game event's ruleset version and rules, the pool at the event, and `ENGINE_VERSION`;
    - the `input_fingerprint` is SHA-256 of their canonical JSON;
    - a live run whose fingerprint equals the current run's is skipped;
    - the new run is `running`. "Newest started" is the highest uuidv7 `id` for the session.
  - `writeAssetLines(db, now, runId): Promise<"written" | "superseded">`. In one transaction, it checks the run is still the newest, deletes the session's lines, inserts the new set (none for a `skip` exception), and makes the run current. It writes `inputs`.
  - `writeTeamAdjustments(db, now, runId, { afterTeamId, batchSize = 1000 }): Promise<{ done: boolean; lastTeamId: string | null } | "superseded">`:
    - it takes the teams with a lock record for the event, in id order, one batch per transaction;
    - each batch takes `pg_advisory_xact_lock` on the game and event, checks the run is still the newest, and replaces the batch's lines for the **whole event** from the current asset lines.
  - `finishRun(db, now, runId)`: `succeeded`, with `diff_summary` (assets and teams whose points changed against the previous current run, and the 10 biggest changes), and `finished_at`.
- [ ] **Step 1: Write the failing tests** (`scoring-runs.test.ts`), on the 2026 import with round 1's recorded race:
  - `a run writes one line per non-zero rule result, tagged with its run`;
  - `the same inputs twice skip the second run`;
  - `an override changes the fingerprint and re-scores`;
  - `a skip exception leaves the session with no lines`;
  - `team_base_lines joins the locked lineup to the asset totals`;
  - `a Late Call team's race base lines use the Late Call version`;
  - `a later run supersedes an earlier one mid-way`: start A, then start and finish B, then continue A, which returns `superseded`; the lines are B's;
  - `re-scoring is idempotent`: after a second, forced live run, the lines are identical apart from `run_id`;
  - `batches cover every locked team exactly once`, with `batchSize` 2 over 5 teams.
- [ ] **Step 2:** Run `pnpm test src/game/scoring-runs.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the schema, then `pnpm db:generate` and `pnpm db:generate --custom --name ledger_rules`, then the functions.
- [ ] **Step 4:** Run `pnpm test src/game src/db && pnpm db:drift`. Expected: PASS, and no drift.
- [ ] **Step 5:** Update DM 4.1–4.3 with what was built. Commit: `feat: scoring runs and the two-tier ledger`.

### Task 5: Event totals, running totals and ranks

**Files:**
- Create: `team_event_totals` in `src/db/schema/scoring.ts`; `src/game/totals.ts`, `src/game/totals.test.ts`.

**Interfaces:**
- Consumes: the views and lines of Task 4.
- Produces:
  - **The table, as DM 4.4 says,** with its two indexes.
  - `recomputeTotals(db, now, { gameId, fromEventId }): Promise<{ events: number; teams: number }>`. In set-based SQL:
    - it rewrites the `team_event_totals` rows for `fromEventId` from the base view plus adjustments, with `points_by_session`;
    - then, for that event and every later one by sequence, it recomputes `cumulative_points`, `first_reached_sequence` and `global_rank`.
    - `first_reached_sequence` is the earliest sequence at which the running total was **at or above** today's;
    - `global_rank` is `rank()` over `(cumulative_points desc, first_reached_sequence asc)`, so ties share a rank;
    - `status` follows the game event: `final` once it's `final`, otherwise `provisional`.
  - A cancelled event has no rows, and the running total carries on over it.
- [ ] **Step 1: Write the failing tests:**
  - `an event's total is its base lines plus its adjustments`;
  - `the running total carries over a cancelled event`;
  - `a dip and a recovery use first at or above`: totals 50, 40 and 50 give `first_reached_sequence` 1 at event 3;
  - `teams tied on points rank by who got there first`;
  - `teams that got there at the same event share a rank`;
  - `a correction to an early event moves later running totals and ranks, but not later points`;
  - `a team that joined late has no rows for earlier events`;
  - `recomputing twice changes nothing`.
- [ ] **Step 2:** Run `pnpm test src/game/totals.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement, then `pnpm db:generate`.
- [ ] **Step 4:** Run `pnpm test src/game && pnpm db:drift`. Expected: PASS. Commit: `feat: event totals, running totals and ranks`.

### Task 6: Leagues and standings

**Files:**
- Create:
  - `src/db/schema/leagues.ts`: `leagues`, `league_memberships`, `league_standings`;
  - the generated migration, and the custom `league_rules` migration;
  - `src/leagues/leagues.ts`, `src/leagues/standings.ts`, and their tests.
- Modify:
  - `src/game/errors.ts`: the codes `league_not_found`, `league_full`, `league_cap`, `team_not_owned` and `already_member`; GL008 is `league_cap`;
  - `src/game/games.ts`: `createGame` also creates the game's `global` league.

**Interfaces:**
- Consumes: `team_event_totals` (Task 5).
- Produces:
  - **The tables, as DM 4.5–4.7 say,** with the CHECK on the `auto_*` kinds, the unique keys per auto league, and the indexes of DM 4.10.
  - **Triggers in `league_rules`:** a membership's team belongs to the league's game, and the 50-league soft cap counts `user` memberships and raises GL008.
  - `createLeague(db, now, { gameId, ownerUserId, kind: "public" | "private", name, startSequence?, endSequence?, maxMembers? }): Promise<{ leagueId; joinCode }>`. The code is 10 characters from an alphabet without look-alikes (`crypto.getRandomValues`), retried on a collision.
  - `joinLeague(db, now, { joinCode, teamId, userId })` and `leaveLeague(db, now, { leagueId, teamId, userId })`. Leaving sets `left_at`, and rejoining makes a new row.
  - `syncAutoLeagues(db, now, { userId, gameId, constructorId: string | null, driverId: string | null, countryCode: string | null })`. It moves every active team of the user into the right auto leagues, creating them as needed, and out of the old ones.
  - `recomputeStandings(db, now, { gameId, eventId }): Promise<{ leagues: number }>`. For every active league except `global` whose range includes the event, it rebuilds `league_standings` over the range, up to the latest event with totals:
    - the tiebreak is computed within the range;
    - `previous_rank` is the rank at the previous `through_event_id`, and stays the same when the through event doesn't change (a correction);
    - only current members count, and retired teams are dropped.
- [ ] **Step 1: Write the failing tests:**
  - `a private league is joined by code, and a wrong code is league_not_found`;
  - `a team can't be in a league twice at a time`;
  - `the 51st user league is refused, and auto leagues don't count`;
  - `a team from another game can't join`;
  - `leaving and rejoining keeps history`;
  - `changing the favorite constructor moves the auto membership`;
  - `the auto league is keyed by constructor, so a rebrand keeps it`;
  - `a mini-league counts only its range`, with the tiebreak inside the range;
  - `a member who joined late ranks on the whole range`;
  - `a retired team drops off the table`;
  - `previous_rank shows movement`;
  - `a 100k-member league is paged by rank` (a SQL plan check with `EXPLAIN` on the index; no 100k rows in the test).
- [ ] **Step 2:** Run `pnpm test src/leagues`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test && pnpm db:drift`. Expected: PASS.
- [ ] **Step 5:** Update DM 4.5–4.7. Commit: `feat: leagues and standings`.

### Task 7: The price formula

**Files:**
- Create: `price_update_runs` in `src/db/schema/game.ts`, plus `asset_prices.run_id`; `src/game/price-formula.ts`, `src/game/price-formula.test.ts`.
- Modify: `src/game/prices.ts`, so `upsertPrices` accepts `source: "formula"` with a `runId`.

**Interfaces:**
- Consumes: `asset_session_totals` (Task 4); `upsertPrices` and `publishPrices`; the `prices.formula` params (Task 1).
- Produces:
  - `priceChange(input: { price: number; assetType; recentPoints: number[]; formula }): { tier: "terrible" | "poor" | "good" | "great"; change: number; newPrice: number }`, which is pure (DM 3.5):
    - it averages up to `formula.window` recent events;
    - the ratio is the average over `price / 10 × pointsPerMillion[assetType]`;
    - a ratio below `thresholds.poor` is terrible, below `good` is poor, below `great` is good, and the rest is great;
    - the change comes from `changes.expensive` at a price of `bandSplit` or more, otherwise from `changes.cheap`;
    - the new price is clamped to `prices.min`–`prices.max`;
    - with no recent events, the price is unchanged and the tier is null.
  - `runPriceUpdate(db, now, { gameId, afterEventId, ranBy }): Promise<{ runId } | { skipped: "next_open" | "no_scores" | "no_next" }>`:
    - it writes the `formula` prices for the next non-cancelled event, and a `price_update_runs` row whose `inputs` hold each asset's recent points, average, ratio and tier;
    - then `publishPrices`;
    - it skips when the next event is no longer `upcoming` (never after a window opened, DM 3.5), when the event has no scored session, and when there's no next event.
- [ ] **Step 1: Write the failing tests:**
  - `each tier maps to its change in each band`;
  - `a price is clamped at $3M and $34M`;
  - `fewer than three events average what there is`;
  - `negative average points are terrible`;
  - `the update writes formula prices and publishes the next event`;
  - `the inputs explain every change`;
  - `an open next event is skipped`;
  - `an event with no scores is skipped`;
  - `a withdrawn asset is still priced`.
- [ ] **Step 2:** Run `pnpm test src/game/price-formula.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement, then `pnpm db:generate`.
- [ ] **Step 4:** Run `pnpm test src/game && pnpm db:drift`. Expected: PASS.
- [ ] **Step 5:** Update DM 3.5. Commit: `feat: the price formula`.

### Task 8: The scoring pipeline

**Files:**
- Create: `src/game/score-jobs.ts`, `src/game/score-jobs.test.ts`.
- Modify:
  - `src/jobs/kinds.ts`: `score_session` and `game_finalize`, their payloads and keys;
  - `src/jobs/poll.ts`, `src/jobs/finalize.ts`, `src/staff/revalidate.ts`: enqueue scoring;
  - `src/game/cancellations.ts`: a session exception enqueues scoring;
  - `src/game/jobs.ts`: `game_open` waits for the previous game event to be `final`, instead of its event being `completed`, with the 24-hour cutoff unchanged;
  - `src/replay/game-script.ts`: `completeEvent` also runs `finalizeGameEvent`;
  - the handler map (`src/providers/pipeline/index.ts`).

**Interfaces:**
- Consumes: Tasks 4–7.
- Produces:
  - `scoreSessionPayload = { gameId, sessionId, runId?, step: "assets" | "teams" | "standings", afterTeamId? }`, with these keys:
    - `score:<gameId>:<sessionId>:v<resultsVersion>` from the results hooks;
    - `score:<gameId>:<sessionId>:x:<auditId>` from an exception change;
    - `score:<runId>:<step>:<afterTeamId|start>` for the continuations.
  - `gameFinalizePayload = { gameId, eventId }`, with the key `game_finalize:<gameId>:<eventId>`.
  - `enqueueScoring(db, now, { sessionId, stamp }): Promise<number>`. It enqueues one job per running game whose game event for the session's event is `locked`, `scored` or `final`, but only when the session's result status is `provisional` or `final`. A session under review enqueues nothing. It returns how many it enqueued.
  - **The `score_session` handler:**
    - `assets` runs `startRun` and `writeAssetLines`;
    - `teams` runs `writeTeamAdjustments`, re-enqueued per batch;
    - `standings` runs `recomputeTotals` from the event, then `recomputeStandings`, then `finishRun`. It moves a `locked` game event to `scored`.
    - A skipped or superseded run stops quietly.
  - `finalizeGameEvent(db, now, { gameId, eventId })`:
    - it re-runs any scored session whose current run doesn't match its fingerprint, inline;
    - then it sets the event's totals to `final`, runs `runPriceUpdate`, and marks the game event `final`;
    - then it enqueues `game_open` for the next event, due now;
    - a `next_open` skip opens a warning review item, `prices_carried`.

    The `game_finalize` handler runs it. The finalize handler enqueues it once it marks an event `completed`.
- [ ] **Step 1: Write the failing tests** (`score-jobs.test.ts`), on round 1's recorded weekend through `replayWeekend`, with a seeded game and two teams:
  - `provisional results score the session through all three steps`;
  - `the event becomes scored, then final after the +48h check`;
  - `a session under review isn't scored, and resolving it scores once`;
  - `an override re-scores, and its totals move`;
  - `a session exception re-scores with no lines`;
  - `the next window opens as soon as the event is final, with formula prices`;
  - `an event final after the next window opened carries prices, and opens prices_carried`;
  - `the same results twice queue one run`;
  - `the M3 season replay still passes` (it runs `src/providers/replay/season-game.test.ts` unchanged).
- [ ] **Step 2:** Run `pnpm test src/game/score-jobs.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5:** Update DM 4.8. Commit: `feat: the scoring pipeline`.

### Task 9: Corrections, the dry run and the daily checks

**Files:**
- Create: `src/game/corrections.ts`, `src/game/corrections.test.ts`; the custom migration `game_rules_10`.
- Modify: `src/jobs/sync-calendar.ts`: the daily checks for each running game.

**Interfaces:**
- Consumes: Tasks 4–8; `writeAudit`, `StaffActor`.
- Produces:
  - **`publishCorrectionVersion(db, now, actor, { gameId, params, rules, notes, eventIds, reason }): Promise<{ rulesetVersionId }>`** (DM 4.9):
    - it creates a version and re-points the listed game events to it;
    - it audits, then enqueues a re-score of every scored session of those events (`trigger: "ruleset_correction"`);
    - `game_rules_10` lets the freeze trigger allow this one update, `game_events.ruleset_version_id` on a locked or later event, only when the transaction sets `gridlocked.ruleset_correction = 'on'`;
    - lock records keep their version.
  - **`dryRunGame(db, now, actor, { gameId, reason }): Promise<{ runId; sessions; assetsChanged; teamsChanged; biggest }>`:**
    - it scores every scored session in memory, with the current engine and rules;
    - it compares the result against the current lines and the stored totals;
    - it writes one `dry_run` run per session with its `diff_summary`, and no lines.
  - **`approveRescore(db, now, actor, { gameId, reason })`:** audited; enqueues a live re-score of every scored session (`trigger: "engine_change"`).
  - **`checkScoreExplanations(db, now, { gameId, sample = 200 })`:** for a sample of teams, the base view plus adjustments must equal the stored totals. On a mismatch, it opens a blocking review item, `score_mismatch`, and enqueues `recomputeTotals`.
  - **`pruneLineupVersions(db, now, { gameId })`:** it deletes versions that no lock record points to, for events `final` for 7 days or more (DM 3.7).
- [ ] **Step 1: Write the failing tests:**
  - `a correction version re-scores the re-pointed events, and is audited`;
  - `re-pointing a locked event outside a correction is still refused`;
  - `a correction keeps the lock records' version`;
  - `a dry run writes no lines and reports the changes`;
  - `approving re-scores the season`;
  - `a hand-broken total opens score_mismatch and is rebuilt`;
  - `pruning keeps every version a lock record uses`.
- [ ] **Step 2:** Run `pnpm test src/game/corrections.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `pnpm test && pnpm db:drift`. Expected: PASS.
- [ ] **Step 5:** Update DM 4.9 and 3.7. Commit: `feat: corrections, the dry run and the daily checks`.

### Task 10: The 2026 season scored (exit)

**Files:**
- Create:
  - `scripts/record-jolpica-2026.ts`: records the qualifying, sprint and race results through the existing rate-limited client;
  - the recorded fixtures under `tests/fixtures/jolpica/2026/`;
  - `src/providers/replay/season-scoring.ts`, `src/providers/replay/season-scoring.test.ts`;
  - `src/game/scoring-invariants.ts`, `src/game/scoring-invariants.test.ts`;
  - `tests/fixtures/scores-2026-expected.json`: each scripted team's total per event.
- Modify:
  - `docs/design/04-implementation-plan.md`: the M4 exit evidence;
  - the formula constants in `RULESET_2026` (calibration).

**Interfaces:**
- Consumes: everything above; `replaySeasonGame` and its script; the penalty injection (`src/providers/replay/penalty.ts`).
- Produces:
  - `checkScoringInvariants(db, gameId): Promise<string[]>`:
    - every total equals base plus adjustments;
    - running totals, `first_reached_sequence` and ranks match a recount in TypeScript;
    - every league table matches a recount;
    - every constructor equals its drivers plus its own lines;
    - a forced re-score of every session changes nothing.
  - `replaySeasonScoring(db, script, { seed, injections })`. Unlike the M3 replay, it runs **the whole pipeline**: poll, finalize, scoring and the game jobs, on the simulated clock, with the fixtures served as each session ends. It returns:

    `{ eventsFinal, sessionsScored, runs, skippedRuns, priceUpdates, totals: Record<teamLabel, number>, violations }`.

- [ ] **Step 1: Record the fixtures.** Run the script for every round that has run (decision 1), and commit them.
- [ ] **Step 2: Write the failing tests:**
  - `the 2026 season scores with no violations`;
  - `each scripted team's totals match the expected file`;
  - `a late stewards' penalty ripples`: inject one on round 5's race after round 7 is scored; round 5's points, every later running total, and the league tables all change; no other event's points change;
  - `every round's game event ends final, and every window after round 1 opens with formula prices`;
  - `rounds 12–14 score the substitution`: Hadjar takes the absent penalties, Lawson's points go to Red Bull, and Tsunoda's go to Racing Bulls' aggregate before he's priced.
- [ ] **Step 3:** Implement. If the replay takes longer than 60 seconds, give it its own `testTimeout`, and record the time in the PR.
- [ ] **Step 4: Calibrate the prices** (decision 2). Write the summary statistics (tier counts, the biggest weekly move, and assets at a bound) into the PR. Update the constants, regenerate the expected totals, and say in the PR which totals moved and why.
- [ ] **Step 5: Cross-check against the official game** (decision 3), for rounds 1, 2 and 13: per-driver and per-constructor points, after taking off overtakes, Driver of the Day and pit stops. Explain every difference. Fix any genuine bug with a failing golden test first, in its own commit.
- [ ] **Step 6:** Run `pnpm test`, `pnpm lint`, `pnpm typecheck` and `pnpm db:drift`. Expected: all PASS.
- [ ] **Step 7:** Write the M4 exit evidence into the roadmap: the PRs, the test counts, the replay's report line, the calibration summary, and the cross-check's match counts. Commit: `test: score the 2026 season (M4 exit)`.

---

## Scenario coverage (DM 4.11)
| Scenario | Task: test |
|---|---|
| Provisional scores after each session | 8: through all three steps |
| Stewards' penalty changes the race order | 8: an override re-scores · 10: ripples |
| Correction to an event after later events | 5: later running totals move · 10 |
| Correction after prices moved | 7: an open next event is skipped (points only) |
| Admin override added or revoked | 4: the fingerprint changes |
| Two corrections a minute apart | 4: a later run supersedes |
| Substitute driver not in the pool | 2: inside his constructor's aggregate |
| Pool driver absent | 2: an inactive pool driver scores -5 |
| Final Fix | 3: Late Call lineups · 4: the view |
| Autopilot with tied top scorers | 3: Strategist ties |
| No Negative per category, penalty still applies | 3: Safety Car |
| x3 Boost plus regular Boost | 3: Overdrive |
| Teams tied on points | 5: who got there first |
| Running total dips, then recovers | 5: first at or above |
| Mini-league from mid-season | 6: only its range |
| Team joins a league late | 6: ranks on the whole range |
| Team leaves and rejoins a league | 6: keeps history |
| User changes favorite team | 6: the auto membership moves |
| Constructor rebrand | 6: keyed by constructor |
| Team retired mid-season | 6: drops off the table |
| Huge public league | 6: paged by rank |
| Join code guessing | 6: 10-character codes (the rate limit is M5) |
| Session voided after scoring | 4, 8: a skip exception |
| Event cancelled before lock | 5: the running total carries over |
| A rule was misconfigured | 9: a correction version |
| Scoring code bug | 9: the dry run, then approval |
| Spoilers via scores | 5: `points_by_session` (the UI is M6) |
| Replay of 2026 | 10 |
