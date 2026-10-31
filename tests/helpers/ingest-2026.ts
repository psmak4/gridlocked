// Test helper for the validator and status tests: a 2026 world with seats and
// event entries, and a one-call "a provider response arrives" for a session.
import { and, eq } from "drizzle-orm";
import { eventEntries, providerIds } from "@/db/schema";
import type { Db } from "@/db/types";
import { normalizeSession } from "@/results/normalize";
import { getSessionContext } from "@/results/session-context";
import type { SessionKind } from "@/results/types";
import { syncEventEntries } from "@/reference/sync-event-entries";
import {
  loadBody,
  parsedFor,
  rowsOf,
  seedResultsWorld,
  sessionIdFor,
  storeResultsSnapshot,
  SEED_AT,
} from "./results-2026";
import { seedSeats2026 } from "./seats-2026";

/** Calendar, roster and seats for 2026 (no event entries yet). */
export async function seedWorldWithSeats(db: Db) {
  await seedResultsWorld(db);
  return seedSeats2026(db, SEED_AT);
}

/** Copies the seats onto the event the session belongs to. */
export async function seedEntriesFor(db: Db, sessionId: string) {
  const { eventId } = await getSessionContext(db, sessionId);
  await syncEventEntries(db, eventId, SEED_AT);
  return eventId;
}

/** Stores a recorded (or edited) body for the session and normalizes it. */
export async function ingest(
  db: Db,
  now: Date,
  sessionId: string,
  kind: SessionKind,
  body: unknown,
) {
  const snapshotId = await storeResultsSnapshot(db, now, sessionId, body);
  const parsed = await parsedFor(db, kind, body);
  await normalizeSession(db, now, sessionId, snapshotId, parsed);
  return snapshotId;
}

/** Entries for the round's event, then the recorded results ingested. */
export async function ingestRecorded(
  db: Db,
  now: Date,
  round: number,
  kind: SessionKind,
  file: string,
) {
  const sessionId = await sessionIdFor(db, round, kind);
  await seedEntriesFor(db, sessionId);
  await ingest(db, now, sessionId, kind, loadBody(`jolpica/2026/${file}`));
  return sessionId;
}

/** Our id for a Jolpica driver or constructor key. */
export async function idFor(
  db: Db,
  entityType: "driver" | "constructor",
  key: string,
): Promise<string> {
  const [row] = await db
    .select({ id: providerIds.entityId })
    .from(providerIds)
    .where(
      and(
        eq(providerIds.provider, "jolpica"),
        eq(providerIds.entityType, entityType),
        eq(providerIds.providerKey, key),
      ),
    );
  if (!row) throw new Error(`no ${entityType} ${key}`);
  return row.id;
}

/**
 * A mid-weekend substitution (DM 1.9): `sub` gets an `admin` entry at
 * `constructorKey` beside the seat entries, and the recorded body is ingested
 * with `replaced`'s row driven by `sub`. Both drivers then have entries.
 */
export async function ingestWithSubstitute(
  db: Db,
  now: Date,
  round: number,
  kind: SessionKind,
  file: string,
  swap: { replaced: string; sub: string; constructorKey: string; car: number },
) {
  const sessionId = await sessionIdFor(db, round, kind);
  const eventId = await seedEntriesFor(db, sessionId);
  await db.insert(eventEntries).values({
    eventId,
    driverId: await idFor(db, "driver", swap.sub),
    constructorId: await idFor(db, "constructor", swap.constructorKey),
    carNumber: swap.car,
    source: "admin",
    createdAt: now,
    updatedAt: now,
  });
  const body = loadBody(`jolpica/2026/${file}`);
  const rows =
    kind === "qualifying"
      ? rowsOf(body, "QualifyingResults")
      : rowsOf(body, "Results");
  const row = rows.find(
    (r) => (r.Driver as { driverId: string }).driverId === swap.replaced,
  );
  if (!row) throw new Error(`no ${swap.replaced} row in ${file}`);
  (row.Driver as { driverId: string }).driverId = swap.sub;
  await ingest(db, now, sessionId, kind, body);
  return { sessionId, eventId };
}
