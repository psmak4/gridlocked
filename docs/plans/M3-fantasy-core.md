# M3 Fantasy Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** teams can be built, locked and changed exactly by the rules (roadmap M3).

**Exit:** the 2026 replay runs locks, transfers and chips for scripted teams across the season, with no rule violations.

**Architecture:**
- **One new module, `src/game/`.** It holds the fantasy game's data and rules. It reads reference data and never writes it, or results (DM 0.5).
- **The database enforces the rules that protect fairness:**
  - the lock;
  - squad shape;
  - budget;
  - chip limits;
  - frozen rulesets and prices.

  These live in triggers in one custom migration, `game_rules`, the way `results_rules` does for M2. The TypeScript functions check the same things first, but only to give a friendly error.
- **Transfer counting and carry-over are pure functions** (`src/game/transfers.ts`). The lock job calls them.
- **Purchasing power is one SQL function,** used both by the save trigger and by the lock job. That way the budget rule exists in exactly one place.
- **Two new job kinds, `game_lock` and `game_open`, run on the existing scheduler tick.** The `sync_calendar` handler plans them, and correctness never depends on them running on time (HLD §3.3 rule 3).
- **No screens and no sign-in.** Those come in M6 and M5. M3 is functions, the database, jobs and the replay.

**Tech Stack:** TypeScript strict, Drizzle, Postgres (PGlite in tests, Neon in staging), Zod, Vitest. No new dependencies.

**Spec:**
- [02-data-model.md](../design/02-data-model.md) Part 3 (3.0–3.13), and 0.3–0.8;
- [01-high-level-design.md](../design/01-high-level-design.md) §3.3, §5.1–5.5 and decision 20;
- [03-ui-brief.md](../design/03-ui-brief.md) "Proposed chip names";
- [04-implementation-plan.md](../design/04-implementation-plan.md) M3.

## Decisions (approved 2 Nov 2026)
The spec left three things open that change what gets built. All three were approved as recommended below.

1. **When the next event's window opens.**
   - **Recommended:** event E+1 opens once event E is final (the +48h finalize check) and E+1's prices are published. If E is still not final 24 hours before E+1's lock, E+1 opens anyway with E's prices carried forward. Between E's lock and the opening, teams can't be changed.
     - This matches the official game.
     - It follows DM 3.5: prices are fixed until the next event and are never applied after a saved team was checked against them.
   - **Alternative:** E+1 opens at E's lock. People can then tinker over the race weekend. The cost is that a lineup saved on Saturday can become over budget when prices change on Tuesday, and something has to decide what happens to it.
2. **The price formula moves to M4.** It averages each asset's fantasy points, and points don't exist until M4.
   - M3 builds everything else: per-event prices, admin prices, the carried fallback, publishing, and freezing at lock.
   - In M3 every window opens with carried prices, so the replay's prices only move when its script changes them.
   - The roadmap's M4 scope gains "the price formula, `price_update_runs` and its calibration on the 2026 replay".
3. **Starting prices for the 2026 replay are our own,** in a test fixture (`tests/fixtures/prices-2026.json`). They are not the official game's.
   - **Recommended:** set them in bands by 2025 championship position, within $3M–$34M.
   - The fixture is made so the $100M cap actually binds: the five most expensive drivers plus the two most expensive constructors cost more than $100M.

**My calls (lower stakes; each is noted in DM Part 3 when its task lands):**
- **Final Fix opens when qualifying's results arrive** (its `session_result_state` leaves `awaiting`) and closes at the race's scheduled start.
  - DM 3.7 says "qualifying is `completed`", but nothing sets `sessions.status` to `completed`.
  - Opening on the scheduled end instead would let someone swap during a rain-delayed qualifying, after seeing Q1.
- **No carry-over out of an unlimited week.** That covers the team's first event, Wildcard and Limitless, as ruleset params. Only Limitless is official (DM 3.8).
- **The x3 Boost target is checked when the chip is played and on every save,** rather than at lock. At lock it's too late to refuse anything. The lock job only asserts the rule held.
- **Lineups saved for an event that's cancelled while its window is open still count:** they carry to the next event's lock (Task 8). Otherwise the cancellation would silently undo people's changes.
- **The 2026 `scoring_rules` rows and their per-kind parameter schemas come in M4,** written alongside the engine that reads them. M3 creates the table and its freeze trigger.
- **`teams.user_id` is a plain uuid until M5 adds `users` and the foreign key.** This is the same as `result_overrides.created_by`.
- **Pruning unlocked lineup versions** (DM 3.7: 7 days after the event is `final`) **comes in M4,** since `final` is a status M4 sets.

## Global Constraints
- **No direct time.** Every function takes `now: Date` from its caller (HLD decision 20). Triggers use `app_now()` as the backstop. Tests move time with `setSimulatedClock` (src/replay/clock-loop.ts), so the app's `now` and `app_now()` agree.
- **Money** is an integer count of $0.1M (`MoneyUnits`, src/lib/money.ts). The budget is `1000`, and prices are `30`–`340`.
- **Layers don't mix.** `src/game/` reads reference data and never writes reference data or results. Game tables reference down the stack only.
- **Every admin change is audited** in the same transaction (`writeAudit`, `StaffActor` from src/staff/roster.ts), with a reason that isn't blank. This covers admin prices, adding and withdrawing pool assets, and session exceptions.
- **Migrations:**
  - the schema goes in `src/db/schema/game.ts`, then `pnpm db:generate`;
  - triggers and SQL functions go in one custom migration, `pnpm db:generate --custom --name game_rules`. A later task appends to it while it's unmerged, or adds `game_rules_2`, `game_rules_3` and so on after it has merged;
  - `pnpm db:drift` stays clean.
- **No new dependencies, and no cloud resources.** Nothing in M3 needs a staging deploy. The next ordinary deploy carries the migrations, and no game is created on staging.
- **Workflow:** one branch `m3/<issue>-<slug>` and one PR per task, closing its issue. CI must be green before merge: lint with zero warnings, format, typecheck, `db:check`, `db:drift`, the full Vitest suite and CodeQL.

## Review Focus
1. **A save in the last second, when the app's clock and `app_now()` disagree** (the app thinks the window is open, the database says it's locked). Expected: a `LineupError` with code `window_closed`, never a 500 and never a saved row. *Pinned in Task 4.*
2. **Qualifying is moved later after `game_lock` was planned** (Suzuka 2019). Expected: the early job sees `now < lock_at`, moves itself to the new `lock_at`, and locks nothing. *Pinned in Task 6.*
3. **Two saves for one team with the same `saved_at`** (two devices, one instant). Expected: the locked lineup is still deterministic: the later uuidv7 `id` wins. *Pinned in Task 4.*
4. **A team keeps a withdrawn driver for several events, then sells him.** Expected: his carried price counts in purchasing power every event, and selling him returns that price to the bank. *Pinned in Task 5.*
5. **The lock job for E runs late, after E+1 has opened and teams have saved for E+1.** Expected: E's state rows are exactly what an on-time run writes, and E+1's versions are ignored. *Pinned in Task 5.*

---

### Task 1: Games, ruleset versions and the game calendar

**Files:**
- Create:
  - `src/db/schema/game.ts`: `games`, `ruleset_versions`, `scoring_rules`, `game_events`;
  - the generated migration, and the custom `game_rules` migration;
  - `src/game/ruleset.ts`, `src/game/ruleset.test.ts`;
  - `src/game/games.ts`, `src/game/games.test.ts`;
  - `src/db/game.test.ts`.
- Modify: `src/db/schema/index.ts` (export the new tables).

**Interfaces:**
- Produces:
  - **The ruleset parameters:** `rulesetParamsSchema` (Zod, `z.strictObject` at every level), with `type RulesetParams = z.infer<…>`.
  - **The 2026 rules:** `RULESET_2026: RulesetParams`:
    - `squad: { drivers: 5, constructors: 2, boosts: 1 }`, `budget: 1000`, `teamsPerUser: 3`;
    - `transfers: { freePerEvent: 2, carryOverMax: 1, penalty: -10, carryOverOutInUnlimitedWeek: 0 }`;
    - `knockout: { q2From: 16, q3From: 10 }`, `prices: { min: 30, max: 340 }`;
    - `window: { openCutoffHours: 24, recheckHours: 6 }`, `abandonedSessions: "score_as_classified"`;
    - `chips`, the array below.
  - **`CHIPS_2026`:** six entries `{ code, name, unlock, effect }`, in this order:
    | code | name | unlock | effect |
    |---|---|---|---|
    | `chip_autopilot` | Strategist | `from_start` | `autopilot` |
    | `chip_triple_boost` | Overdrive | `from_start` | `triple_boost` |
    | `chip_no_negative` | Safety Car | `from_start` | `no_negative` |
    | `chip_wildcard` | Rebuild | `after_first_event` | `wildcard` |
    | `chip_limitless` | Blank Cheque | `after_first_event` | `limitless` |
    | `chip_final_fix` | Late Call | `after_first_event` | `final_fix` |
  - `createGame(db, now, { seasonId, slug, name, params: RulesetParams, notes }): Promise<{ gameId: string; rulesetVersionId: string }>`:
    - creates a `season_fantasy` game in `setup`, with version 1 effective from the season's first non-cancelled event;
    - then calls `planGameEvents`.
  - `planGameEvents(db, now, gameId): Promise<void>`: one `game_events` row per event of the season.
    - `sequence` is 1..n by `events.lock_at` over non-cancelled events. Cancelled events have `sequence` null and status `cancelled`.
    - `ruleset_version_id` is the version with the latest `effective_from` event whose `lock_at` is at or before this event's `lock_at`.
    - Rows whose status is `locked` or later are never changed.
    - Running it again changes nothing. Task 8 extends what it does for a cancellation.
  - `GAME_EVENT_STATUSES = ["upcoming", "open", "locked", "scored", "final", "cancelled"]`. M3 uses the first three and `cancelled`.

- [ ] **Step 1: Write the failing tests.**
  - `ruleset.test.ts`:
    - `RULESET_2026 parses`;
    - `an unknown key is refused`;
    - `a chip code that isn't unique is refused`;
    - `prices.min above prices.max is refused`.
  - `games.test.ts`, on the imported 2026 calendar (`importReference2026`):
    - `createGame numbers the season's events by lock time`: 23 rows, sequences 1..23 in `lock_at` order;
    - `a second game for the same season and type is refused`;
    - `planning again changes nothing`;
    - `an event whose lock_at moves before lock is renumbered`;
    - `a locked event keeps its sequence when the calendar changes`;
    - `a second ruleset version applies from its event onward`: events before it keep version 1.
  - `src/db/game.test.ts`, the freeze trigger:
    - `a ruleset version can be edited while no event using it has locked`;
    - `updating a version used by a locked event raises`;
    - `inserting a scoring rule into such a version raises`.
- [ ] **Step 2:** Run `pnpm test src/game src/db/game.test.ts`. Expected: FAIL (modules missing).
- [ ] **Step 3:** Define the schema as DM 3.1–3.3 says:
  - unique `(season_id, game_type)`, and unique `(game_id, version)`;
  - `scoring_rules` has its columns and the `kind` CHECK over the seven kinds of DM 3.2, with unique `(ruleset_version_id, code)`;
  - `game_events` has composite PK `(game_id, event_id)`, and `sequence` is nullable.

  Then write the freeze trigger into `game_rules`. It covers `UPDATE` and `DELETE` on `ruleset_versions`, and every write to `scoring_rules`, whenever a `game_events` row with status `locked`, `scored` or `final` uses the version.
- [ ] **Step 4:** Implement `src/game/ruleset.ts` and `src/game/games.ts`. Run `pnpm test src/game src/db && pnpm db:drift`. Expected: PASS, and no drift.
- [ ] **Step 5:** Update DM 3.2 and 3.3: our chip names and codes, the `window` and `transfers` params, and that the 2026 `scoring_rules` rows come in M4. Commit: `feat: games, ruleset versions and the game calendar`.

### Task 2: The pool and per-event prices

**Files:**
- Create:
  - `src/game/pool.ts`, `src/game/pool.test.ts`;
  - `src/game/prices.ts`, `src/game/prices.test.ts`;
  - `tests/fixtures/prices-2026.json`;
  - `tests/helpers/game-2026.ts`.
- Modify: `src/db/schema/game.ts` (`pool_assets`, `asset_prices`), the `game_rules` migration, `src/db/game.test.ts`.

**Interfaces:**
- Consumes: `createGame`, `planGameEvents` (Task 1); `writeAudit`, `StaffActor`.
- Produces:
  - `seedPool(db, now, { gameId, fromEventId }): Promise<{ drivers: number; constructors: number }>`:
    - one `active` asset per constructor in `constructor_seasons`, and per driver holding a `race` seat on the event's first-session date;
    - `added_from_event_id = fromEventId`;
    - running it again adds nothing.
  - `addPoolAsset(db, now, { gameId, driverId?: string, constructorId?: string, fromEventId, price: MoneyUnits, reason, actor }): Promise<string>`:
    - adds a mid-season substitute (HLD §8.1) and publishes its `admin` price for `fromEventId`, all audited;
    - refused when `fromEventId`'s game event isn't `upcoming` or `open`.
  - `withdrawPoolAsset(db, now, { assetId, fromEventId, reason, actor }): Promise<void>`: sets the asset `withdrawn`, audited.
  - `publishPrices(db, now, { gameId, eventId, prices: Array<{ assetId: string; price: MoneyUnits }>, source: "initial" | "admin", reason?, actor? }): Promise<void>`:
    - upserts the prices and sets `game_events.prices_ready_at = now`;
    - `admin` needs a `reason` and an `actor`, and is audited.
  - `carryPrices(db, now, { gameId, eventId }): Promise<number>`:
    - copies each asset's latest earlier price into `eventId` as `carried`, for every asset that has no row there, including withdrawn ones;
    - sets `prices_ready_at`, and returns the rows written.
  - `priceList(db, { gameId, eventId }): Promise<Map<string, MoneyUnits>>`.
  - Test helper: `seedGame2026(db, now): Promise<{ gameId: string; assetId: (jolpicaKey: string) => Promise<string> }>`. It imports the reference data, then runs `createGame`, `seedPool` from round 1, and `publishPrices` from the fixture as `initial`.

- [ ] **Step 1: Write the failing tests.**
  - `pool.test.ts`:
    - `the 2026 pool has 22 drivers and 11 constructors`;
    - `seeding again adds nothing`;
    - `a pool asset must be exactly one of driver or constructor`: a direct insert with both set, or neither, raises;
    - `a substitute added for round 13 has an admin price there and an audit row`;
    - `withdrawing keeps the asset's rows`.
  - `prices.test.ts`:
    - `a price outside $3M–$34M is refused` (CHECK);
    - `prices for a locked event can't change`: an update after the game event is `locked` raises;
    - `carryPrices copies the last price, including for a withdrawn asset`;
    - `carrying again writes nothing`;
    - `an admin price without a reason is refused before any write`.
  - The fixture's own test, in `prices.test.ts`:
    - `the 2026 starting prices fit the bounds`;
    - `the cap binds`: the five most expensive drivers plus the two most expensive constructors cost more than 1000;
    - `a full team fits`: the five cheapest drivers plus the two cheapest constructors cost 1000 or less.
- [ ] **Step 2:** Run `pnpm test src/game/pool.test.ts src/game/prices.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Define `pool_assets` and `asset_prices` as DM 3.4–3.5 says, with the CHECKs and unique keys, and `source` in `initial`, `formula`, `admin`, `carried`.
  - **Leave out `asset_prices.run_id`:** M4 adds it with `price_update_runs`.
  - Add the `asset_prices (event_id)` index (DM 3.10).
  - Append the price-freeze trigger to `game_rules`.
  - Write `tests/fixtures/prices-2026.json` as `{ "drivers": { "<jolpica key>": units }, "constructors": { … } }`, following decision 3.
- [ ] **Step 4:** Implement. Run `pnpm test src/game src/db && pnpm db:drift`. Expected: PASS.
- [ ] **Step 5:** Update DM 3.5 (the formula is in M4; carried prices open a window). Commit: `feat: the pool and per-event prices`.

### Task 3: Teams

**Files:**
- Create: `src/game/teams.ts`, `src/game/teams.test.ts`.
- Modify: `src/db/schema/game.ts` (`teams`), `game_rules`, `src/db/game.test.ts`.

**Interfaces:**
- Consumes: `seedGame2026` (Task 2).
- Produces:
  - `createTeam(db, now, { gameId, userId, name, slot? }): Promise<string>`:
    - takes the lowest free slot when `slot` is absent;
    - refused unless the game is `open` or `running`;
    - `name` is trimmed, and must be 1–30 characters.
  - `renameTeam(db, now, { teamId, name }): Promise<void>`.
  - `removeTeam(db, now, teamId): Promise<"deleted" | "retired">`: deletes a team with no `first_event_id`, and retires any other.
  - `class GameError extends Error { code: GameErrorCode }`, with `GameErrorCode = "game_not_open" | "no_free_slot" | "bad_name"`. Later tasks add codes to this union.

- [ ] **Step 1: Write the failing tests.**
  - `teams.test.ts`:
    - `a user gets slots 1, 2 and 3, and a fourth team is refused`, with code `no_free_slot`;
    - `a team can't be created while the game is in setup`;
    - `a team with no locked event is deleted`;
    - `a team that has locked is retired, not deleted`: set `first_event_id` directly for this test;
    - `a blank name is refused`.
  - `src/db/game.test.ts`:
    - `slot 4 is refused by the database`: a direct insert, so the trigger reads `teamsPerUser` from the game's latest ruleset version;
    - `two creates for the same slot can't both succeed`: two transactions inserting `(game, user, 3)`, and exactly one commits.
- [ ] **Step 2:** Run `pnpm test src/game/teams.test.ts src/db/game.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Define `teams` as DM 3.6 says. `user_id` is a plain uuid (decided above), with `teams (user_id)` indexed. Add the slot trigger to `game_rules`.
- [ ] **Step 4:** Implement. Run `pnpm test src/game src/db`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: teams, three per user`.

### Task 4: Lineup versions and the database-enforced lock

**Files:**
- Create: `src/game/lineups.ts`, `src/game/lineups.test.ts`.
- Modify: `src/db/schema/game.ts` (`lineup_versions`, `lineup_picks`), `game_rules`, `src/db/game.test.ts`.

**Interfaces:**
- Consumes: `createTeam` (Task 3), `seedGame2026`, `priceList` (Task 2).
- Produces:
  - `openGame(db, now, gameId): Promise<void>`:
    - moves the game from `setup` to `open`, and its sequence-1 event to `open`;
    - refused unless that event has prices for every active asset.
  - `saveLineup(db, now, { teamId, picks: Array<{ assetId: string; isBoost: boolean }>, basedOnVersionId: string | null }): Promise<{ versionId: string; staleBase: boolean }>`:
    - `for_event_id` is the game's single `open` event;
    - `kind` is `regular`, or `limitless` when that chip is played for the event (Task 7);
    - `staleBase` is true when `basedOnVersionId` isn't the team's latest version.
  - `lockedLineup(db, { teamId, eventId }): Promise<{ versionId: string; picks: Array<{ assetId: string; isBoost: boolean }> } | null>`:
    - the latest `regular` or `limitless` version for the event with `saved_at < lock_at`, ordered by `(saved_at, id)`;
    - otherwise the team's base, carried forward (Task 5 supplies the base);
    - `null` when the team has neither.
  - `GameErrorCode` gains `"window_closed" | "composition" | "asset_unavailable" | "over_budget"`. Each database refusal is mapped to its code, so no trigger error ever reaches a caller raw.

- [ ] **Step 1: Write the failing tests.**
  - `lineups.test.ts`, with the clock moved by `setSimulatedClock`:
    - `a save one second before lock counts`;
    - `a save at lock_at is refused with window_closed`;
    - `the app clock says open but app_now() says locked`: pass `now = lock_at - 1s` while `simulated_clock = lock_at`. Expect `window_closed` and no row (Review Focus 1);
    - `six drivers, one constructor, two Boosts, or a Boost on a constructor are refused with composition`;
    - `a partial lineup can't be saved`;
    - `an asset added from a later event, a withdrawn asset, or another game's asset is refused with asset_unavailable` (Task 5 lets a team keep a withdrawn asset it already owns);
    - `two devices: the later save counts, and the earlier one's next save reports staleBase`;
    - `two saves with the same saved_at: the later id counts` (Review Focus 3);
    - `swapping only the Boost is a new version with the same assets`.
  - `src/db/game.test.ts`:
    - `a version for an event that isn't open is refused`;
    - `saved_at comes from app_now(), not from the insert`;
    - `a lock_at can't be moved to a time already past`: an update of `events.lock_at` to a time at or before `app_now()` raises, for an event that has a game row (DM 3.11). The calendar sync already refuses to move a lock that has passed (M2's `lock_passed_changed`). This trigger is the backstop for a future lock being moved into the past.
- [ ] **Step 2:** Run `pnpm test src/game/lineups.test.ts src/db/game.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Define the tables as DM 3.7 says:
  - `kind` is `regular`, `limitless` or `final_fix`;
  - `lineup_picks` has composite PK `(lineup_version_id, asset_id)` and `ON DELETE CASCADE`;
  - the indexes from DM 3.10.

  In `game_rules`:
  - a `BEFORE INSERT` trigger sets `saved_at = app_now()`;
  - a `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED` on `lineup_versions` and `lineup_picks` checks:
    - the window (`regular` and `limitless` versions only; Task 7 adds `final_fix`);
    - composition from the version's ruleset params;
    - asset availability by sequence: `added_from` at or before the event, and not withdrawn at or before it.

  Add the `events.lock_at` guard to `game_rules` as well. **Budget, and keeping a withdrawn asset, come in Task 5.**
- [ ] **Step 4:** Implement. Run `pnpm test src/game src/db`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: lineup versions and the database-enforced lock`.

### Task 5: Transfers, team value and the lock record

**Files:**
- Create:
  - `src/game/transfers.ts`, `src/game/transfers.test.ts`;
  - `src/game/lock.ts`, `src/game/lock.test.ts`.
- Modify: `src/db/schema/game.ts` (`team_event_states`), `game_rules`, `src/game/lineups.ts`, `src/game/lineups.test.ts`.

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces:
  - **Pure transfer functions** (`src/game/transfers.ts`):
    - `netTransfers(baseAssetIds: string[], lockedAssetIds: string[]): number`: the assets in the locked lineup that aren't in the base. Boost is ignored.
    - `freeTransfers(params, { isFirstEvent: boolean; carryIn: number; unlimited: boolean }): number | null`: `null` (unlimited) on a first event or an unlimited chip week, otherwise `freePerEvent + carryIn`.
    - `carryOverOut(params, { free: number | null; made: number }): number`: `carryOverOutInUnlimitedWeek` when `free` is null, otherwise `min(carryOverMax, max(0, free - made))`.
    - `transferPenalty(params, { free: number | null; made: number }): number`: `0` when `free` is null, otherwise `penalty × max(0, made - free)`.
  - **SQL functions in `game_rules`:**
    - `team_base_state(team_id uuid, event_id uuid) RETURNS TABLE(base_version_id uuid, bank integer, carry_in integer, is_first boolean)`. It reads the team's latest `team_event_states` row before the event, by sequence. When that row is a Limitless week, it returns that row's `base_version_id`, the bank of the row before it, and a `carry_in` of 0.
    - `team_purchasing_power(team_id uuid, event_id uuid) RETURNS integer`: `budget` on a first event, otherwise `bank` plus the base lineup's assets at this event's prices.
    - **The save trigger gains two rules:**
      - the budget check: the version's cost must be at most `team_purchasing_power`. `limitless` versions skip it;
      - a withdrawn asset is allowed when it's in `base_version_id`.
  - `lockEvent(db, now, { gameId, eventId, afterTeamId?: string, limit?: number }): Promise<{ written: number; lastTeamId: string | null; done: boolean }>`:
    - refused while `now < lock_at`;
    - for every `active` team with a locked lineup, writes one `team_event_states` row (DM 3.8): insert, or do nothing if the row is already there;
    - sets `teams.first_event_id` where it's null;
    - works in batches of `limit` (default 1000), in team id order;
    - on the last batch, sets the game event `locked`, and the game `running`.
  - `saveLineup` starts raising `over_budget`, the code declared in Task 4.

- [ ] **Step 1: Write the failing tests.**
  - `transfers.test.ts`, one case for each DM 3.8 formula:
    - `a revert is free`;
    - `a Boost-only swap is 0`;
    - `two unused with one carried in carries only 1`;
    - `three made with two free costs -10`;
    - `an unlimited week has no penalty and carries 0`.
  - `lock.test.ts`, on `seedGame2026`:
    - `the first event: purchasing power is the budget, transfers are unlimited, and first_event_id is set`;
    - `a team's second event counts transfers against the first locked lineup`;
    - `out and back in across two saves in one window is free`;
    - `an owned asset's price rise raises purchasing power`: set an admin price for round 2;
    - `an unchanged lineup stays affordable after every owned price falls`;
    - `a withdrawn driver kept for three events counts at his carried price, and selling him returns it` (Review Focus 4);
    - `a team created after round 1's lock gets no row there and starts at round 2`;
    - `a team that never saved gets no row`;
    - `a retired team gets no row`;
    - `locking twice writes the same rows`;
    - `locking before lock_at is refused`;
    - `a late lock of round 1, after round 2 opened and teams saved for it, writes what an on-time lock writes` (Review Focus 5);
    - `batches of 2 over 5 teams write all 5 and set locked once`.
  - `lineups.test.ts`:
    - `a withdrawn asset already owned can be kept, but not bought back after it's sold`;
    - `an over-budget save is refused with over_budget`;
    - `a save that spends exactly the purchasing power is accepted`.
- [ ] **Step 2:** Run `pnpm test src/game`. Expected: FAIL.
- [ ] **Step 3:** Define `team_event_states` as DM 3.8 says:
  - `free_transfers` is nullable;
  - the `team_event_states (event_id)` index.

  "The bank is never negative outside Limitless" isn't a CHECK, because a CHECK can't see the chip. It's asserted by `lockEvent`, and again by Task 9's invariants. Then write the SQL functions and the two save-trigger rules.
- [ ] **Step 4:** Implement `transfers.ts` and `lock.ts`. `lockedLineup` gets its carried-forward base from `team_base_state`. Run `pnpm test src/game src/db`. Expected: PASS.
- [ ] **Step 5:** Update DM 3.8 (the unlimited-week carry-over param, and the two SQL functions). Commit: `feat: transfers, team value and the lock record`.

### Task 6: The game jobs: lock and open

**Files:**
- Create: `src/game/jobs.ts`, `src/game/jobs.test.ts`.
- Modify:
  - `src/jobs/kinds.ts` (add `game_lock` and `game_open`, with their payloads and key helpers);
  - `src/jobs/functions/tick.ts` (spread `createGameHandlers()` next to `createPipelineHandlers(...)`; the game handlers stay out of `src/providers`);
  - `src/jobs/sync-calendar.ts` (call `planGameJobs` after `planEventJobs`);
  - `src/jobs/sync-calendar.test.ts`.

**Interfaces:**
- Consumes: `lockEvent` (Task 5), `carryPrices` (Task 2), `openGame` (Task 4), `enqueue`.
- Produces:
  - `planGameJobs(db, gameId): Promise<void>`:
    - enqueues `game_lock` (`game_lock:<game>:<event>`) at `lock_at` for every `upcoming` or `open` event;
    - enqueues `game_open` (`game_open:<game>:<event>`) for each `upcoming` event after the first, at its previous event's race `scheduled_end` plus the largest `finalizer_checks` hour.
  - `createGameHandlers(): Record<"game_lock" | "game_open", JobHandler>`:
    - **`game_lock`:** when `now < lock_at`, it re-enqueues itself at `lock_at` and does nothing. Otherwise it runs one `lockEvent` batch, and enqueues a continuation (`…:after:<lastTeamId>`) until `done`.
    - **`game_open`:** opens the event when its previous game event is `locked`, and either the previous event's `events.status` is `completed` or `now ≥ lock_at − openCutoffHours`.
      - Opening: `carryPrices` when `prices_ready_at` is null (M4 puts the formula here), then the event goes `open`.
      - If it isn't time yet, it enqueues `…:<n>` at `now + recheckHours`.
  - The payload Zod schemas follow `kinds.ts`'s style: ids only, and the handler reads the current state from the database.

- [ ] **Step 1: Write the failing tests.**
  - `jobs.test.ts`:
    - `planning puts a lock job at each event's lock_at`;
    - `planning again moves a job when lock_at moved`;
    - `a lock job that runs early because qualifying moved later reschedules and locks nothing` (Review Focus 2);
    - `round 2 opens with carried prices once round 1 is completed`;
    - `round 2 stays closed while round 1 is not completed, re-checking every 6 hours`;
    - `round 2 opens with carried prices 24 hours before its lock even if round 1 is still under review`;
    - `round 2 never opens before round 1 is locked`.
  - `sync-calendar.test.ts`: `a calendar sync plans the season's game jobs`.
- [ ] **Step 2:** Run `pnpm test src/game/jobs.test.ts src/jobs`. Expected: FAIL.
- [ ] **Step 3:** Implement. Run `pnpm test`. Expected: PASS: the full suite, since the tick changed.
- [ ] **Step 4:** Commit: `feat: game lock and open jobs on the scheduler`.

### Task 7: Chips, including Limitless and Final Fix

**Files:**
- Create: `src/game/chips.ts`, `src/game/chips.test.ts`.
- Modify: `src/db/schema/game.ts` (`chip_plays`), `game_rules`, `src/game/lineups.ts`, `src/game/lock.ts`, and their tests.

**Interfaces:**
- Consumes: Tasks 4–6.
- Produces:
  - `playChip(db, now, { teamId, chipCode, targetAssetId? }): Promise<string>`:
    - plays a chip for the open event;
    - `chip_triple_boost` needs a `targetAssetId`: a driver in the team's latest lineup that isn't the 2x Boost one;
    - `chip_final_fix` can't be played here (see `saveFinalFix`).
  - `saveFinalFix(db, now, { teamId, outAssetId, inAssetId }): Promise<{ versionId: string; chipPlayId: string }>`. In one transaction, it:
    - plays `chip_final_fix`;
    - saves a `final_fix` version, which is the locked lineup with one same-type swap. The Boost moves to the incoming driver if the outgoing one had it;
    - sets `effective_from_session_id` to the race;
    - updates the event's `team_event_states` row, setting `final_fix_version_id` and `chip_play_id`.
  - `refundChips(db, now, { gameId, eventId }): Promise<number>`: system only. It sets `played` to `refunded` for the event.
  - **Effects at lock** (`lockEvent`):
    - Wildcard and Limitless make the week unlimited (`free = null`);
    - Limitless skips the budget, and the next event's base reverts (already in `team_base_state`);
    - `chip_play_id` is recorded;
    - the x3 rule is asserted, and the job fails loudly if it's broken.
  - **Changes to `saveLineup`:**
    - it saves `kind = limitless` when Limitless is played for the event;
    - with x3 played, a lineup that drops the target or puts the 2x Boost on it is refused with `composition`.
  - `GameErrorCode` gains `"chip_unavailable" | "chip_window_closed"`.

- [ ] **Step 1: Write the failing tests.**
  - `chips.test.ts`, every DM 3.9 and 3.11 chip row:
    - `a chip can be played once per season`;
    - `only one chip per race`;
    - `Rebuild, Blank Cheque and Late Call are refused at the team's first event and allowed at its second`;
    - `Strategist, Overdrive and Safety Car work at the team's first event`;
    - `Overdrive on the 2x Boost driver is refused`;
    - `after Overdrive, moving the Boost onto its target is refused`;
    - `a played chip can't be deleted or un-played`: a direct `DELETE`, and an update to anything but `refunded`, both raise;
    - `Rebuild: four transfers, no penalty, carry-over 0, and the result is the next base`;
    - `Blank Cheque: an over-budget lineup locks, no carry-over, and the next event's base is the pre-Blank Cheque lineup with its bank, at the new prices`;
    - `Late Call before qualifying's results are in is refused with chip_window_closed`;
    - `Late Call after the race's scheduled start is refused`;
    - `Late Call on a sprint weekend opens after qualifying, not after sprint qualifying`;
    - `Late Call moves the Boost to the incoming driver`;
    - `Late Call with two swaps, or a driver for a constructor, is refused`;
    - `Late Call over the event's purchasing power is refused`;
    - `after Late Call, the next event's base is the locked lineup, not the Late Call one`.
  - `src/db/game.test.ts`: `a final_fix version outside its window is refused by the database`.
- [ ] **Step 2:** Run `pnpm test src/game src/db`. Expected: FAIL.
- [ ] **Step 3:** Define `chip_plays` as DM 3.9 says, with both partial unique indexes, and `chip_plays (event_id) WHERE status = 'played'`. In `game_rules`:
  - **the play trigger checks:**
    - that the code is in the event's ruleset params;
    - the window: before lock, or the Final Fix window;
    - the unlock rule, by sequence against `first_event_id`;
  - **an update/delete guard;**
  - **the `final_fix` window branch** in the lineup trigger.
- [ ] **Step 4:** Implement. Run `pnpm test src/game src/db`. Expected: PASS.
- [ ] **Step 5:** Update DM 3.7 (the Final Fix opening signal) and DM 3.9 (where the x3 check runs). Commit: `feat: chips, including Blank Cheque and Late Call`.

### Task 8: Cancellations and abandoned sessions

**Files:**
- Create: `src/game/cancellations.ts`, `src/game/cancellations.test.ts`.
- Modify:
  - `src/db/schema/game.ts` (`game_session_exceptions`);
  - `game_rules`;
  - `src/game/games.ts` (`planGameEvents`);
  - `src/game/lineups.ts` (`lockedLineup`);
  - and their tests.

**Interfaces:**
- Consumes: `refundChips` (Task 7), `carryPrices` (Task 2), `planGameEvents` (Task 1).
- Produces:
  - **`planGameEvents` handles an event cancelled before its lock.** In one transaction it:
    - sets the event's game row to `cancelled`;
    - calls `refundChips`;
    - if the cancelled event was `open`, opens the next upcoming event, with `carryPrices` first when it has no prices.
  - **`lockedLineup` and `lockEvent` also count versions saved for cancelled events** between the team's base event and this one (decided above).
  - `setSessionException(db, now, { gameId, sessionId, policy: "skip", reason, actor }): Promise<void>` and `clearSessionException(db, now, { gameId, sessionId, reason, actor }): Promise<void>`. Both are audited. The re-score they trigger arrives in M4.

- [ ] **Step 1: Write the failing tests.**
  - `cancellations.test.ts`, one for each DM 3.9 and 3.11 cancellation row:
    - `an event cancelled before lock refunds its chips and writes no state rows`;
    - `the next event counts transfers against the last real locked lineup, with no extra free transfers`;
    - `prices don't change across a cancellation`;
    - `a lineup saved for the cancelled open event counts at the next lock`;
    - `the next event opens at once when the open event is cancelled`;
    - `a race cancelled after qualifying keeps its chips played and its state rows`;
    - `a refunded chip can be played again later`;
    - `a session exception is audited, and a second one for the same session is refused`.
- [ ] **Step 2:** Run `pnpm test src/game`. Expected: FAIL.
- [ ] **Step 3:** Define `game_session_exceptions` with PK `(game_id, session_id)`, as DM 3.3 says. `decided_by` is a plain uuid until M5; the audit row carries the actor.
- [ ] **Step 4:** Implement. Run `pnpm test src/game src/db`. Expected: PASS.
- [ ] **Step 5:** Update DM 3.9 (lineups saved for a cancelled event carry forward). Commit: `feat: cancellations and abandoned sessions in the game`.

### Task 9: The 2026 season replay (exit)

**Files:**
- Create:
  - `src/replay/game-script.ts`: the script types and `applyGameAction`;
  - `src/game/invariants.ts`, `src/game/invariants.test.ts`;
  - `src/providers/replay/season-game.ts`, `src/providers/replay/season-game.test.ts`;
  - `tests/fixtures/game-2026-script.json`.
- Modify: `docs/design/04-implementation-plan.md`: the M3 exit evidence (decision 2 is already in the M4 scope).

**Interfaces:**
- Consumes: everything above; `runReplayClock` and `setSimulatedClock` (src/replay/clock-loop.ts); `importReference2026`; the handler wiring of `replayWeekend` (src/providers/replay/harness.ts), as the model.
- Produces:
  - **`GameAction`:** the replay's scripted moves, each with an ISO `at` and a team label:
    - `create`, `save` (picks as Jolpica keys and a Boost), `chip`, `finalFix`;
    - `expectRefused` (wraps another action and names its `GameErrorCode`);
    - `adminPrice`, `cancelEvent`;
    - `completeEvent`: sets `events.status = completed` at the last finalize-check time. It stands in for the finalizer, which M2's replay already proved, because the import plans no pipeline jobs.

    Jolpica keys are resolved in the test helper, never in `src/game`.
  - `checkGameInvariants(db, gameId): Promise<string[]>`: one message per violation. It recomputes every `team_event_states` row from versions, prices and chip plays, and compares. It also checks:
    - no counted version has `saved_at ≥ lock_at`;
    - carry-over is never above 1;
    - each penalty equals `transferPenalty`;
    - the bank is never negative outside Limitless;
    - each chip is played at most once per season, and one per event;
    - unlock rules hold;
    - x3 is never on the 2x driver;
    - Final Fix is exactly one same-type swap, inside its window.
  - `replaySeasonGame(db, script): Promise<{ eventsLocked: number; eventsCancelled: number; states: number; chipPlays: number; refused: number; violations: string[] }>`. It:
    - imports the 2026 reference data;
    - seeds the game with `seedGame2026`, then runs `openGame`;
    - drives `runReplayClock` (`step: "jump"`), with only the game handlers, from 24 hours before round 1's lock to 72 hours after the last race;
    - applies the script's actions as clock-loop `actions`;
    - returns `checkGameInvariants` as `violations`.

- [ ] **Step 1: Write the script and the failing tests.**
  - The script has eight teams, each with one job:
    1. set and forget;
    2. one transfer a week (carry-over);
    3. heavy transfers (penalties);
    4. a revert;
    5. all six chips across the season, including Late Call on a sprint weekend;
    6. a late joiner created after round 5's lock;
    7. two devices (a stale base);
    8. a team that keeps a driver who is withdrawn mid-season.

    The script also cancels one round before its lock (synthetic: no 2026 round was cancelled outright. Saudi Arabia is off the calendar, and Bahrain moved to round 16 as the Bahrain Grand Prix in Malaysia, at Sepang), with a chip played for it. It includes a save one minute before a lock and one at the lock, wrapped in `expectRefused`.
  - `invariants.test.ts`: `each invariant reports a hand-broken state row`, one case per check, by writing a bad row directly.
  - `season-game.test.ts`:
    - `the 2026 season replays with no rule violations`: `violations` is `[]`;
    - every round but the cancelled one locks;
    - `refused` equals the script's `expectRefused` count;
    - every team in the script has a state row for each event it took part in.
- [ ] **Step 2:** Run `pnpm test src/game/invariants.test.ts src/providers/replay/season-game.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. If the replay test takes longer than 60 seconds, give it its own `testTimeout`, and record the time in the PR.
- [ ] **Step 4:** Run `pnpm test`, `pnpm lint`, `pnpm typecheck` and `pnpm db:drift`. Expected: all PASS.
- [ ] **Step 5:** Write the M3 exit evidence into the roadmap's M3 section: the PR numbers, the test counts, and the replay's report line. Commit: `test: replay the 2026 season's game rules (M3 exit)`.

---

## Scenario coverage (DM 3.11)
| Scenario | Task: test |
|---|---|
| Joining after the season starts | 5: created after round 1's lock · 9: late joiner |
| Save at the deadline | 4: one second before; at lock_at; the clocks disagree |
| Qualifying rescheduled before lock | 1: renumbered · 6: an early lock job reschedules |
| Session delayed after lock | 6: nothing re-opens (a lock job never runs twice) |
| Two devices | 4: later save counts, staleBase · 9: team 7 |
| Swapping the Boost only | 4, 5: Boost-only swap is 0 |
| Reverting a transfer | 5: out and back in is free · 9: team 4 |
| Carry-over capped, must be used | 5: carries only 1 |
| Limitless, then the team restored | 7: Blank Cheque |
| Final Fix after qualifying, Boost moves | 7: Late Call |
| Final Fix on a sprint weekend | 7: opens after qualifying |
| x3 Boost on the 2x Boost driver | 7: Overdrive refusals |
| Chips unlock for the team's 2nd race | 7: first event versus second |
| Driver injured or replaced | 5: withdrawn driver kept (owners keep penalties: M4) |
| Substitute becomes pickable | 2: substitute from round 13 |
| Driver or team leaves for good | 2: withdrawing · 4: kept, not bought |
| Prices not ready by the next lock | 6: opens with carried prices 24 hours before |
| Correction after prices moved | M4 (points only; prices are frozen at lock, Task 2) |
| Owned asset's price rises or falls | 5: rise; unchanged stays affordable |
| Event cancelled before lock | 8 · 9: the synthetic cancelled round |
| Race cancelled after qualifying | 8 |
| Abandoned race with a classification | 8: session exception (re-score in M4) |
| Mid-season rule change | 1: a second version from its event |
| Squad size or budget changes | 1: params · 3: the slot trigger reads the param |
| User deletes a team mid-season | 3: retired, not deleted |
| Season rollover | 1: one game per season and type |
| Replaying 2026 with a fake clock | 9 |
