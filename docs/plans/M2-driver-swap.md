# M2 Driver Swap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** when a team swaps a driver, staff can record it in one audited action, either for one event or from an event onward, and the checks then accept the real line-up instead of holding scoring.

**Why now:** at Mexico City 2026, Haas announced on the Saturday that Hirakawa would replace Ocon from FP3. Reading the code against that case showed three things:
- **No staff action:** there is no way to record the swap except hand-written SQL. The tools for this are in M8, in February.
- **Two detection gaps:** a driver who drops out after FP2 isn't flagged, and a reserve with no seat can't be matched in the practice data.
- **A validator bug:** DM 1.9 says a mid-weekend substitute and the driver he replaces both have entries ("three drivers sharing two cars is valid"). But the validator calls a session complete only when it has a row for every entry. With 23 entries and 22 cars, the session can never become provisional.

**Architecture:**
- **One rule for both checks:** a new helper works out which absent entrants are really missing. A team is expected to run `min(its entries, carsPerConstructor)` cars, and only a team short of that has missing drivers. The validator and the roster check both use it.
- **Staff actions are plain functions** in `src/staff/`. Each writes `audit_log` in the same transaction as the change (DM 0.4), then re-checks the event.
- **Until M8 builds the screens,** staff run the actions with a script, `pnpm staff`. For staging, a manual GitHub workflow runs that script with the staging secrets and records the GitHub login of whoever started it. M8 later builds its UI over the same functions.

**Tech Stack:** TypeScript strict, Drizzle, Postgres (Neon), Vitest with the existing test database helper, GitHub Actions. No new dependencies.

**Spec:**
- [01-high-level-design.md](../design/01-high-level-design.md) §8 (roster changes and substitutes);
- [02-data-model.md](../design/02-data-model.md) 0.4 (admin changes are audited), 1.8 (seats), 1.9 (entries and the mid-weekend substitution), 1.10 (availability), 6.6 (`audit_log`);
- the Mexico City 2026 case in the M2 ledger (2026-10-31 lines).

## Global Constraints
- **No direct time:** every function takes `now` from the caller. Scripts get it from `resolveClock`, as `scripts/import-2026.ts` does.
- **No new dependencies;** no deploy and no staging write during a live race weekend (FP1 to the race's end).
- **Staging writes happen only through the `staff-action` workflow,** started by you, or with your OK in chat for each run. Claude never handles the staging database URL.
- **Every staff write is audited** in the same transaction, with a required reason that isn't blank.
- **History is never edited** (DM 1.8): a seat change closes one range and opens another.
- **Existing guard rails stay:** lint with zero warnings, format, typecheck, schema drift, the full Vitest suite, all in CI.
- **Workflow:** one branch `m2/<issue>-<slug>` and one PR per task, each closing its issue, with CI green before merge.

## Review Focus
1. **The daily calendar sync (06:00 UTC) after a substitution.** Expected: both entries survive, because the sync never touches `admin` entries. *Pinned in Task 4.*
2. **Running the same action twice** (a retry after a workflow timeout). Expected: the second run changes nothing and writes no audit row. *Pinned in Task 4.*
3. **A swap recorded after results are in.** Expected: an `under_review` session moves to `provisional` and a `final` session stays `final`. *Pinned in Task 4.*
4. **A substitute who already has an entry at the event,** such as a team-mate moving between the team's two cars. Expected: his entry is updated, not duplicated, and the old values go into the audit row. *Pinned in Task 4.*
5. **Garbled or hostile workflow input.** Expected: the input is rejected before any write, and the inputs never reach a shell command line. *Pinned in Task 5.*

---

### Task 1: Three drivers, two cars (the validator)

**Files:**
- Create: `src/reference/expected-cars.ts`, `src/reference/expected-cars.test.ts`
- Modify: `src/results/validate.ts`, `src/results/validate.test.ts`, `src/results/status.test.ts`

**Interfaces:**
- Produces:
  - `expectedCars(entries: Array<{ driverId: string; constructorId: string }>, carsPerConstructor: number): number`: the sum over constructors of `min(entries for it, carsPerConstructor)`.
  - `absentEntrants(entries, presentDriverIds: Set<string>, carsPerConstructor: number): string[]`: the absent entrants of every constructor that has fewer present drivers than its expected cars, sorted by driver id. Task 2 uses it too.

- [ ] **Step 1: Write the failing tests.**
  - `expected-cars.test.ts`:
    - `a team with three entries expects two cars`;
    - `a full team has no absent entrants even when one of its three is absent`;
    - `a team with three entries and one car running lists both absent entrants`.
  - `validate.test.ts`, the Mexico shape. Take a complete recorded 2026 race. Add an `admin` entry for a third driver at one team, then use overrides to `suppress` one race driver's row and `insert` the substitute's row for the same team.
    - `a mid-weekend substitute with both entries is complete`: the kinds include no `incomplete`, `missing_driver` or `unknown_driver`.
    - `a team short of a car reports only its own absent entrants`: drop one of that team's rows. Expect `incomplete`, with `missingDriverIds` equal to that team's two absent entrants.
  - `status.test.ts`:
    - `a substitute's session advances to provisional`;
    - `a provisional substitute session that loses the substitute's row opens missing_driver for that team only`.
- [ ] **Step 2:** Run `pnpm test src/reference/expected-cars.test.ts src/results`. Expected: the new tests FAIL. Before the change, `incomplete` is reported with 23 entries and 22 rows.
- [ ] **Step 3:** Implement the two helpers.
- [ ] **Step 4:** Change `validateSession`:
  - `incomplete` = `rows.length < expectedCars(entries, carsPerConstructor)`;
  - `missingDriverIds` and the `missing_driver` problems come from `absentEntrants`;
  - update the doc comment.

  `advanceStatus` needs no change: it already reads `missingDriverIds`.
- [ ] **Step 5:** Run `pnpm test`. Expected: everything passes, including the recorded 2026 rounds, which are all complete with two entries per team.
- [ ] **Step 6:** Commit: `fix: a substitute and the driver he replaces share two cars (DM 1.9)`.

### Task 2: The roster check sees a swap after FP2

**Files:**
- Modify: `src/reference/roster-check.ts`, `src/reference/roster-check.test.ts`, `src/providers/openf1/participants.ts`, `src/providers/openf1/participants.test.ts`

**Interfaces:**
- Consumes: `absentEntrants` and `getSetting(db, "validator_thresholds").carsPerConstructor` (Task 1).

- [ ] **Step 1: Write the failing tests.**
  - `roster-check.test.ts`:
    - `a driver who ran FP2 but not FP3 is missing`: Ocon is in FP2 and absent from FP3, where only Bearman is stored for Haas. Expect one `missing_driver` for Ocon.
    - `after a recorded substitution, the replaced driver is not missing`: Hirakawa has an `admin` entry and is stored for Haas in FP3. Expect no `missing_driver`.
    - `a driver absent from FP2 but present in FP3 is not missing`.
  - `participants.test.ts`:
    - `a substitute entered for the event is matched by the entry's car number`: Hirakawa has no seat and no code, but has an entry with car 99. A row for car 99, acronym `HIR`, team Haas, is stored as his participation, and no `unknown_driver` opens.
- [ ] **Step 2:** Run `pnpm test src/reference/roster-check.test.ts src/providers/openf1/participants.test.ts`. Expected: FAIL.
- [ ] **Step 3: Roster check.** Judge "missing" on the **latest** practice session that has participants (FP3 if it has any, otherwise FP2), through `absentEntrants`. Team changes are still judged across both sessions. Update the doc comment.
- [ ] **Step 4: OpenF1 matching.** Load the event's `event_entries` and match a row by car number among them first, with the same acronym guard as seats. Then fall back to seats, then to the acronym.
- [ ] **Step 5:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 6:** Commit: `fix: catch a driver swap after FP2 and match an entered substitute`.

### Task 3: The audit log

**Files:**
- Modify: `src/db/schema/` (a new `audit.ts`, exported from the schema index)
- Create: `src/audit/log.ts`, `src/audit/log.test.ts`, a migration from `pnpm db:generate`, and a hand-written migration for the trigger (the pattern `0003_reference_constraints.sql` uses)

**Interfaces:**
- Produces:
  - `writeAudit(tx: Db, now: Date, entry: AuditEntry): Promise<void>`.
  - `AuditEntry = { actorKind: "admin" | "moderator" | "user" | "system" | "job"; actorLabel: string | null; action: string; entityType: string; entityId: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null; reason: string | null; requestId: string | null }`.

- [ ] **Step 1: Write the failing tests:**
  - `writes one row with the given fields`;
  - `an update is refused`;
  - `a delete is refused`, by the trigger, with SQL run directly.
- [ ] **Step 2:** Run `pnpm test src/audit`. Expected: FAIL (no table).
- [ ] **Step 3: Add the table** with DM 6.6's columns:
  - `actor_user_id` and `impersonating_user_id` are nullable uuids with **no** foreign key yet; the FK to `users` arrives in M5, as `review_items.resolved_by` does.
  - Add the indexes from DM 6.6.
  - Add one more column, `actor_label text` (nullable), for who acted until there are user rows. The staff workflow writes the GitHub login there.
  - Add the append-only trigger that refuses `UPDATE` and `DELETE`.
- [ ] **Step 4:** Run `pnpm db:check`, `pnpm db:drift` and `pnpm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: the append-only audit log (DM 6.6)`.

### Task 4: The staff actions

**Files:**
- Create: `src/staff/roster.ts`, `src/staff/roster.test.ts`, `src/staff/revalidate.ts`

**Interfaces:**
- Consumes: `writeAudit` (Task 3), `rosterCheck`, `advanceStatus`, `syncEventEntries`, `localDate`.
- Produces:
  - `StaffActor = { kind: "admin"; label: string }`, and `SessionMove = { sessionId: string; kind: string; previous: string; next: string }`.
  - `revalidateEvent(db, now, eventId): Promise<SessionMove[]>`: runs `rosterCheck`, then `advanceStatus` for every scored session of the event that has a `session_result_state` row.
  - `recordSubstitution(db, now, input: { eventId; inDriverId; constructorId; carNumber: number; outDriverId: string | null; reason: string; actor: StaffActor }): Promise<{ changed: boolean; sessions: SessionMove[] }>`. It works for **this event only**. In one transaction it:
    - upserts the `admin` entry (in driver, constructor, car);
    - if there's an out driver, upserts his `driver_availability` as `unavailable`, with the reason as given and source `admin`;
    - writes audit rows `event_entry.create`/`event_entry.update` and `driver_availability.update`, each with only the changed fields in `before` and `after`.

    Then it runs `revalidateEvent`. It refuses, with nothing written:
    - a blank reason;
    - an out driver with no entry at that constructor;
    - a car number another constructor's entry at the event already uses.
  - `changeSeats(db, now, input: { fromEventId; changes: Array<{ driverId; constructorId: string | null; carNumber?: number }>; reason; actor }): Promise<{ eventsSynced: number; sessions: SessionMove[] }>`. It works **from this event onward**. "From" is `localDate` of the event's first session, in the circuit's zone. In one transaction it:
    - closes each driver's race seat that is active on that date, with `valid_to` = the day before;
    - opens a race seat from that date wherever `constructorId` is set (`carNumber` is required then);
    - audits each seat row (`seat_assignment.close`, `seat_assignment.open`);
    - runs `syncEventEntries` for every event of the season whose first session falls on or after the date and isn't completed or cancelled.

    Then it runs `revalidateEvent(fromEventId)`. It refuses a seat that starts on or after the date: changing a future seat isn't supported, which keeps history unedited.

- [ ] **Step 1: Write the failing tests** (`roster.test.ts`, on the recorded 2026 world, with one recorded race set up as the Mexico case):
  - `Mexico: a substitution after the race clears the hold`. Qualifying and the race have Hirakawa's rows and are `under_review`, with blocking `unknown_driver` items. After `recordSubstitution`:
    - both sessions are `provisional`;
    - Hirakawa's items are auto-resolved;
    - Ocon is `unavailable` with source `admin`;
    - exactly two audit rows exist, both with the reason and the actor label.
  - `the next calendar sync keeps both entries` (Review Focus 1).
  - `running it twice changes nothing and writes no second audit row` (Review Focus 2).
  - `a final session stays final` (Review Focus 3).
  - `a substitute who already has an entry is updated, not duplicated` (Review Focus 4).
  - `a blank reason, an out driver not entered for that team, and a clashing car number are refused, with nothing written`.
  - `changeSeats: the DM 1.8 Dutch GP swap from round 12`. Lawson to Red Bull, Tsunoda to Racing Bulls, Hadjar's race seat ended. Expect:
    - the old seats close on 2026-08-20 and the new ones open on 2026-08-21;
    - the entries of round 12 and later match the new seats;
    - earlier rounds don't change.
  - `changeSeats refuses a seat that starts on or after the from date`.
- [ ] **Step 2:** Run `pnpm test src/staff`. Expected: FAIL.
- [ ] **Step 3:** Implement `revalidateEvent`, `recordSubstitution` and `changeSeats` to the interfaces above.
- [ ] **Step 4:** Run `pnpm test`. Expected: PASS.
- [ ] **Step 5:** Commit: `feat: staff actions for a substitution and a seat change`.

### Task 5: The `pnpm staff` script and the staging workflow

**Files:**
- Create: `scripts/staff.ts`, `scripts/staff.test.ts`, `.github/workflows/staff-action.yml`
- Modify: `package.json` (`"staff": "tsx scripts/staff.ts"`), `README.md`

**Interfaces:**
- Consumes: `recordSubstitution`, `changeSeats` (Task 4).
- Produces:
  - `pnpm staff <substitute|seats>`, configured only through environment variables:
    - `STAFF_EVENT`: `season/round`, resolved through Jolpica `provider_ids`;
    - `STAFF_CHANGE`: JSON. For `substitute`: `{ "in": "<jolpica driver key>", "team": "<jolpica constructor key>", "car": <n>, "out": "<key>" | null }`. For `seats`: `[{ "driver": "<key>", "team": "<key>" | null, "car": <n>? }]`;
    - `STAFF_REASON`, `STAFF_ACTOR`, `STAFF_DRY_RUN` and `DATABASE_URL`.
  - It refuses to run without `STAFF_ACTOR` or with a blank reason.
  - With `STAFF_DRY_RUN=true` it resolves every key and prints the planned writes, but writes nothing.

- [ ] **Step 1: Write the failing tests** (`staff.test.ts`, on the test database):
  - `a dry run resolves the keys and writes nothing`;
  - `an unknown driver key, malformed JSON or a missing actor is refused before any write` (Review Focus 5);
  - `a real run records the substitution and prints the session moves`.
- [ ] **Step 2:** Run `pnpm test scripts/staff.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the script.** Parse the environment with Zod, use the system clock through `resolveClock`, and keep the refusals of `import-2026.ts` (no replay database, no CLOCK_MODE other than system).
- [ ] **Step 4: Add `staff-action.yml`:**
  - triggered by `workflow_dispatch` only;
  - inputs: `command` (a choice of `substitute` or `seats`), `event`, `change`, `reason`, `dry_run` (boolean, default **true**);
  - `environment: staging`, using `DATABASE_URL_STAGING`;
  - every input is passed through `env:` and never written into a `run:` line (Review Focus 5);
  - `STAFF_ACTOR: ${{ github.actor }}`;
  - pinned action SHAs and the same concurrency group as `deploy-staging`, so a staff run and a deploy never overlap.
- [ ] **Step 5:** Run `pnpm test`, `pnpm lint` and `pnpm typecheck`. Expected: PASS.
- [ ] **Step 6:** Commit: `feat: pnpm staff and the staff-action workflow`.

### Task 6: Design docs and roadmap

**Files:**
- Modify: `docs/design/01-high-level-design.md` §8.2, `docs/design/02-data-model.md` 1.9 and 6.6, `docs/design/04-implementation-plan.md` M2 and M8

- [ ] **Step 1: Update the docs:**
  - HLD §8.2: staff record an announcement with `pnpm staff` (the workflow on staging) until M8.
  - DM 1.9: the completeness rule (`min(entries, carsPerConstructor)` per team).
  - DM 6.6: `actor_label`, and the user FKs that M5 adds.
  - Roadmap: the M2 scope gains "staff actions for a substitution and a seat change"; M8 builds its seats-and-availability screen on them.
- [ ] **Step 2:** Run `pnpm format:check`. Expected: PASS.
- [ ] **Step 3:** Commit: `docs: record the driver swap actions`.

### Task 7: Mexico on staging (controller, after the weekend, on your OK)

- [ ] **Step 1:** Deploy with `gh workflow run deploy-staging.yml --ref main`, import unchecked. Then confirm the migrations ran and a new tick deployment is `completed`.
- [ ] **Step 2:** Run `staff-action` as a dry run for Mexico: `substitute`, `{ "in": "ryo_hirakawa", "team": "haas", "car": <from the stored results>, "out": "ocon" }`, with a reason. Read the plan it prints.
- [ ] **Step 3:** With your OK, run it for real. Then, read-only, check:
  - qualifying and the race are `provisional`;
  - Hirakawa's items are resolved;
  - two audit rows exist;
  - the next held finalize check marks Mexico `final`.
- [ ] **Step 4:** Write the result into the M2 exit evidence.

## Done when
- The validator and the roster check accept a mid-weekend substitute and catch a swap after FP2.
- Staff can record a substitution or a seat change in one audited action, locally and on staging.
- Mexico City 2026 is final on staging through that action, not through hand-written SQL.

## Calls I made (check these)
- **Mexico waits for this code.** No hand fix after the race: the one you approved wouldn't clear the hold (see "Why now"), and a workaround would have to be undone later. The held finalize check re-runs every 6 hours, so Mexico finalizes on the first check after Task 7. *Cost if wrong:* Mexico is final days later than 3 Nov.
- **One deploy instead of two.** Task 7's deploy is also M2.5 Task 4's staging check, which was waiting for Mexico to finalize.
- **`actor_label` added to `audit_log`.** It holds a GitHub login until there are users (M5).
- **No undo action.** A mistaken substitution is corrected by recording the right one. M8 adds a proper undo.
- **The workflow defaults to a dry run,** and only you (or Claude, with your OK for each run) start a real one.
