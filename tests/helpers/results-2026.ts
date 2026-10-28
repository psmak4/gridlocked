// Test helper: a synced 2026 season (calendar, drivers, constructors, with
// their Jolpica provider ids), and recorded results turned into normalizer
// input. The one place a src/results test reaches into src/providers (see the
// override in eslint.config.mjs).
import { and, eq } from "drizzle-orm";
import { events, sessions } from "@/db/schema";
import type { Db } from "@/db/types";
import { simulatedClock } from "@/lib/clock";
import { newId } from "@/lib/ids";
import { mapJolpicaKeys } from "@/providers/jolpica/normalize-session";
import { parseJolpicaResults } from "@/providers/jolpica/results";
import { storeSnapshot } from "@/providers/snapshots";
import { syncCalendar } from "@/reference/sync-calendar";
import { syncConstructors, syncDrivers } from "@/reference/sync-roster";
import type { ParsedResults, SessionKind } from "@/results/types";
import { loadCalendar2026 } from "./calendar-2026";
import { readFixture } from "./fixtures";
import { loadConstructors2026, loadDrivers2026 } from "./roster-2026";

export const SEED_AT = new Date("2026-02-01T00:00:00.000Z");

/** Syncs the 2026 calendar, drivers and constructors into `db`. */
export async function seedResultsWorld(db: Db) {
  const clock = simulatedClock(SEED_AT);
  await syncCalendar(db, clock, 2026, {
    events: loadCalendar2026(),
    snapshotId: newId(),
  });
  await syncDrivers(db, clock, 2026, {
    items: loadDrivers2026(),
    snapshotId: newId(),
  });
  await syncConstructors(db, clock, 2026, {
    items: loadConstructors2026(),
    snapshotId: newId(),
  });
}

/** The id of a session of the event in `round` of 2026. */
export async function sessionIdFor(
  db: Db,
  round: number,
  kind: SessionKind,
): Promise<string> {
  const [row] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .innerJoin(events, eq(events.id, sessions.eventId))
    .where(and(eq(events.round, round), eq(sessions.kind, kind)));
  if (!row) throw new Error(`no ${kind} session in round ${round}`);
  return row.id;
}

/** Stores `body` as a snapshot of the session's results question. */
export async function storeResultsSnapshot(
  db: Db,
  now: Date,
  sessionId: string,
  body: unknown,
): Promise<string> {
  const { id } = await storeSnapshot(db, {
    provider: "jolpica",
    endpoint: `/results/${sessionId}`,
    params: { limit: "100" },
    body,
    now,
    sessionId,
  });
  return id;
}

/** Parses a Jolpica body and maps its keys to our ids, as the adapter does. */
export async function parsedFor(
  db: Db,
  kind: SessionKind,
  body: unknown,
): Promise<ParsedResults> {
  const parsed = parseJolpicaResults(kind, body);
  if (!parsed.ok) return parsed;
  const mapped = await mapJolpicaKeys(db, parsed.rows);
  if ("unmapped" in mapped) {
    throw new Error(
      `unmapped keys: ${mapped.unmapped.map((u) => u.key).join(", ")}`,
    );
  }
  return { ok: true, rows: mapped.rows };
}

/** A fresh copy of a recorded body, ready to edit. */
export function loadBody(path: string): {
  MRData: { RaceTable: { Races: Array<Record<string, unknown>> } };
} {
  return structuredClone(readFixture(path)) as ReturnType<typeof loadBody>;
}

/** The result rows of a recorded body, in place (so edits show in the body). */
export function rowsOf(
  body: ReturnType<typeof loadBody>,
  key: string,
): Array<Record<string, unknown>> {
  return body.MRData.RaceTable.Races[0]![key] as Array<Record<string, unknown>>;
}
