import { eq } from "drizzle-orm";
import { resultChanges, results, sessionResultState } from "@/db/schema";
import type { Db } from "@/db/types";
import { newId } from "@/lib/ids";
import { openReviewItem } from "@/reference/review";
import { getSessionContext } from "./session-context";
import type { ParsedResults, ResultRow } from "./types";

// The normalizer (DM 2.4, 2.5): turns one parsed provider response into the
// session's `results` rows and a log of what changed. It knows nothing about
// providers: the adapter hands it rows that already carry our ids.

/** Compared fields: `results` column name, and the row property that holds it. */
const FIELDS = [
  ["constructor_id", "constructorId"],
  ["car_number", "carNumber"],
  ["position", "position"],
  ["classification", "classification"],
  ["provider_status", "providerStatus"],
  ["provider_position_text", "providerPositionText"],
  ["grid", "grid"],
  ["pit_lane_start", "pitLaneStart"],
  ["laps", "laps"],
  ["time_ms", "timeMs"],
  ["fastest_lap_rank", "fastestLapRank"],
  ["fastest_lap_ms", "fastestLapMs"],
  ["q1_ms", "q1Ms"],
  ["q2_ms", "q2Ms"],
  ["q3_ms", "q3Ms"],
  ["official_points", "officialPoints"],
] as const satisfies ReadonlyArray<readonly [string, keyof ResultRow]>;

function asText(value: string | number | boolean | null): string | null {
  return value === null ? null : String(value);
}

/**
 * Replaces the session's results with `parsed` (DM 2.4), in one transaction,
 * and logs each field that changed for each driver (DM 2.5).
 *
 * `snapshotId` is the snapshot `parsed` came from, always the one passed in:
 * a refetch that reverts to older content reuses the older snapshot row, so
 * "latest snapshot" would be wrong. Normalizing a snapshot that is already
 * the session's current one writes nothing.
 *
 * A failed parse writes nothing to `results` and keeps the previous rows. It
 * opens one blocking review item, `unknown_classification` or
 * `validation_failed`, which a rerun of the same snapshot does not repeat.
 *
 * The first normalization of a session logs no changes: nothing was there to
 * change from. `changed` counts the `result_changes` rows written.
 */
export async function normalizeSession(
  db: Db,
  now: Date,
  sessionId: string,
  snapshotId: string,
  parsed: ParsedResults,
): Promise<{ changed: number }> {
  return db.transaction(async (tx) => {
    let failure: { code: string; problem: string } | null = parsed.ok
      ? null
      : { code: parsed.code, problem: parsed.problem };
    if (parsed.ok) {
      const seen = new Set<string>();
      for (const row of parsed.rows) {
        if (seen.has(row.driverId)) {
          failure = {
            code: "validation_failed",
            problem: `driver ${row.driverId} appears twice`,
          };
          break;
        }
        seen.add(row.driverId);
      }
    }
    if (failure !== null) {
      const ctx = await getSessionContext(tx, sessionId);
      await openReviewItem(tx, now, {
        kind: failure.code,
        severity: "blocking",
        seasonId: ctx.seasonId,
        eventId: ctx.eventId,
        sessionId,
        details: { problem: failure.problem, snapshotId },
        dedupeKey: `normalize:${sessionId}:${snapshotId}`,
      });
      return { changed: 0 };
    }
    if (!parsed.ok) throw new Error("unreachable");

    // Serialise with any other normalization of this session.
    await tx
      .insert(sessionResultState)
      .values({ sessionId })
      .onConflictDoNothing();
    const [state] = await tx
      .select()
      .from(sessionResultState)
      .where(eq(sessionResultState.sessionId, sessionId))
      .for("update");
    if (state!.currentSnapshotId === snapshotId) return { changed: 0 };

    const previous = new Map(
      (
        await tx.select().from(results).where(eq(results.sessionId, sessionId))
      ).map((r) => [r.driverId, r]),
    );
    const incoming = new Map(parsed.rows.map((r) => [r.driverId, r]));

    const changeRows: Array<typeof resultChanges.$inferInsert> = [];
    if (state!.currentSnapshotId !== null) {
      const log = (
        driverId: string,
        field: string,
        oldValue: string | null,
        newValue: string | null,
      ) =>
        changeRows.push({
          id: newId(),
          sessionId,
          driverId,
          field,
          oldValue,
          newValue,
          fromSnapshotId: state!.currentSnapshotId!,
          toSnapshotId: snapshotId,
          detectedAt: now,
        });
      for (const [driverId, row] of incoming) {
        const old = previous.get(driverId);
        if (!old) {
          log(driverId, "row", "absent", "present");
          continue;
        }
        for (const [field, key] of FIELDS) {
          const before = asText(old[key]);
          const after = asText(row[key]);
          if (before !== after) log(driverId, field, before, after);
        }
      }
      for (const driverId of previous.keys()) {
        if (!incoming.has(driverId)) log(driverId, "row", "present", "absent");
      }
    }

    await tx.delete(results).where(eq(results.sessionId, sessionId));
    if (parsed.rows.length > 0) {
      await tx
        .insert(results)
        .values(parsed.rows.map((row) => ({ ...row, sessionId, snapshotId })));
    }
    if (changeRows.length > 0)
      await tx.insert(resultChanges).values(changeRows);
    await tx
      .update(sessionResultState)
      .set({
        currentSnapshotId: snapshotId,
        version: state!.version + 1,
      })
      .where(eq(sessionResultState.sessionId, sessionId));
    return { changed: changeRows.length };
  });
}
