import { eq } from "drizzle-orm";
import { effectiveResults, eventEntries } from "@/db/schema";
import type { Db } from "@/db/types";
import { absentEntrants, expectedCars } from "@/reference/expected-cars";
import { getSetting } from "@/settings";
import { getSessionContext } from "./session-context";
import type { SessionKind } from "./types";

// The results validator (HLD §4.4, §8.2). It reads `effective_results`, never
// `results`, so an admin's correction is validated like provider data. It only
// reports: opening review items and moving the status is `advanceStatus`.

/**
 * Session kinds that score, and so have results to validate: the official game
 * scores Qualifying, Sprint and Race (HLD §6). Sprint qualifying is not
 * scored, so like practice it has no results requirement here and the
 * finalizer does not wait for it.
 */
export const SCORED_KINDS: readonly SessionKind[] = [
  "qualifying",
  "sprint",
  "race",
];

export type ProblemKind =
  /** Fewer rows than expected cars: the results are not all out yet. Not a failure. */
  | "incomplete"
  | "no_event_entries"
  | "unknown_driver"
  | "unknown_constructor"
  | "team_change"
  | "missing_driver"
  | "too_many_cars"
  | "positions_not_contiguous"
  | "implausible_grid"
  | "multiple_fastest_laps";

export interface Problem {
  kind: ProblemKind;
  /** `blocking` holds the session; `incomplete` is only a `warning`. */
  severity: "blocking" | "warning";
  details: Record<string, unknown>;
}

/**
 * What a problem is about, for a stable review-item key: the driver, else the
 * constructor, else the session as a whole.
 */
export function problemSubject(problem: Problem): string {
  const { driverId, constructorId } = problem.details;
  if (typeof driverId === "string") return driverId;
  if (typeof constructorId === "string") return constructorId;
  return "session";
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The HLD §4.4 checks for one session, on its effective rows:
 * - every expected car is accounted for. A team is expected to run
 *   `min(its entries, carsPerConstructor)` cars, because a mid-weekend
 *   substitute and the driver he replaces both have entries (DM 1.9). Fewer
 *   rows than expected cars is `incomplete`, not a failure; once the count is
 *   met, the absent entrants of a team short of a car are `missing_driver`;
 * - no driver or constructor the event does not list, and every
 *   driver-constructor pair is in `event_entries` (`unknown_driver`,
 *   `unknown_constructor`, `team_change`: HLD §8.2);
 * - classified positions are contiguous from 1 (checked once complete);
 * - grids are plausible (sprint and race);
 * - at most one fastest lap rank 1;
 * - at most `validator_thresholds.carsPerConstructor` cars per constructor,
 *   counted within this session.
 *
 * A practice session has no results and no problems.
 */
export async function validateSession(
  db: Db,
  sessionId: string,
): Promise<Problem[]> {
  const ctx = await getSessionContext(db, sessionId);
  if (!SCORED_KINDS.includes(ctx.kind)) return [];

  const rows = await db
    .select()
    .from(effectiveResults)
    .where(eq(effectiveResults.sessionId, sessionId));
  const entries = await db
    .select()
    .from(eventEntries)
    .where(eq(eventEntries.eventId, ctx.eventId));
  const { carsPerConstructor } = await getSetting(db, "validator_thresholds");

  // Rows still to come can fill a gap in the order, so it is judged only
  // once the count is met.
  const carsExpected = expectedCars(entries, carsPerConstructor);
  const incomplete = entries.length > 0 && rows.length < carsExpected;
  const problems: Problem[] = [];
  const add = (
    kind: ProblemKind,
    details: Record<string, unknown>,
    severity: Problem["severity"] = "blocking",
  ) => problems.push({ kind, severity, details });

  // Who is expected, and who is there.
  if (entries.length === 0) {
    add("no_event_entries", {});
  } else {
    const entryByDriver = new Map(entries.map((e) => [e.driverId, e]));
    const entryConstructors = new Set(entries.map((e) => e.constructorId));
    const present = new Set(rows.map((r) => r.driverId));
    const absent = absentEntrants(entries, present, carsPerConstructor);

    if (incomplete) {
      add(
        "incomplete",
        {
          expected: carsExpected,
          actual: rows.length,
          missingDriverIds: absent,
        },
        "warning",
      );
    } else {
      for (const driverId of absent) add("missing_driver", { driverId });
    }

    const rowsByDriver = [...rows].sort((a, b) =>
      byText(a.driverId, b.driverId),
    );
    for (const row of rowsByDriver) {
      const entry = entryByDriver.get(row.driverId);
      if (!entry) {
        add("unknown_driver", {
          driverId: row.driverId,
          constructorId: row.constructorId,
          carNumber: row.carNumber,
        });
      } else if (entry.constructorId !== row.constructorId) {
        add("team_change", {
          driverId: row.driverId,
          constructorId: row.constructorId,
          expectedConstructorId: entry.constructorId,
          carNumber: row.carNumber,
        });
      }
    }
    const unknownConstructors = new Set(
      rows
        .map((r) => r.constructorId)
        .filter((id) => !entryConstructors.has(id)),
    );
    for (const constructorId of [...unknownConstructors].sort(byText)) {
      add("unknown_constructor", { constructorId });
    }
  }

  // Cars per constructor, within this session.
  const cars = new Map<string, number>();
  for (const r of rows)
    cars.set(r.constructorId, (cars.get(r.constructorId) ?? 0) + 1);
  for (const [constructorId, count] of [...cars].sort(([a], [b]) =>
    byText(a, b),
  )) {
    if (count > carsPerConstructor) {
      add("too_many_cars", {
        constructorId,
        cars: count,
        allowed: carsPerConstructor,
      });
    }
  }

  // Classified positions run 1..n with no gap and no repeat (once complete).
  const classified = rows.filter((r) => r.classification === "classified");
  const positions = classified.map((r) => r.position);
  const sorted = positions.map((p) => p ?? -1).sort((a, b) => a - b);
  if (!incomplete && !sorted.every((p, i) => p === i + 1)) {
    add("positions_not_contiguous", {
      classified: classified.length,
      positions: sorted,
    });
  }

  // Grids: inside the field, none shared. A pit-lane start has no grid.
  if (ctx.kind === "sprint" || ctx.kind === "race") {
    const field = Math.max(rows.length, entries.length);
    const grids = rows.filter((r) => r.grid !== null);
    const outOfRange = grids
      .filter((r) => r.grid! < 1 || r.grid! > field)
      .map((r) => ({ driverId: r.driverId, grid: r.grid }))
      .sort((a, b) => byText(a.driverId, b.driverId));
    const seen = new Set<number>();
    const duplicateGrids = new Set<number>();
    for (const r of grids) {
      if (seen.has(r.grid!)) duplicateGrids.add(r.grid!);
      seen.add(r.grid!);
    }
    if (outOfRange.length > 0 || duplicateGrids.size > 0) {
      add("implausible_grid", {
        outOfRange,
        duplicateGrids: [...duplicateGrids].sort((a, b) => a - b),
        field,
      });
    }
  }

  // At most one fastest lap.
  const fastest = rows
    .filter((r) => r.fastestLapRank === 1)
    .map((r) => r.driverId)
    .sort(byText);
  if (fastest.length > 1) add("multiple_fastest_laps", { driverIds: fastest });

  return problems;
}
