import { and, asc, eq, gte, isNull, lte, or } from "drizzle-orm";
import {
  circuits,
  eventEntries,
  events,
  seatAssignments,
  sessions,
} from "@/db/schema";
import type { Db } from "@/db/types";

export interface EventEntriesReport {
  inserted: number;
  updated: number;
  removed: number;
}

/** `YYYY-MM-DD` of an instant in an IANA zone; UTC if the zone is unknown. */
function localDate(at: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

/**
 * Copies the expected line-up onto an event (DM 1.9): every `race` seat that
 * is active on the date of the event's first session (a date in the circuit's
 * own zone, the way an admin picks "from the Dutch GP onwards"). Entries
 * written here have `source = 'seat'`. An entry an admin changed
 * (`source = 'admin'`) or that results created (`'results'`) is never touched.
 * A `'seat'` entry whose seat no longer applies is removed, since it is only
 * a copy. Safe to run again.
 *
 * `now` stamps `updated_at` on rows this call changes; new rows take the
 * column default. Callers inside a sync pass the sync's `now`.
 */
export async function syncEventEntries(
  db: Db,
  eventId: string,
  now?: Date,
): Promise<EventEntriesReport> {
  return db.transaction(async (tx) => {
    const [event] = await tx
      .select({
        seasonId: events.seasonId,
        timezone: circuits.timezone,
      })
      .from(events)
      .innerJoin(circuits, eq(circuits.id, events.circuitId))
      .where(eq(events.id, eventId));
    if (!event) throw new Error(`syncEventEntries: no event ${eventId}`);

    const [first] = await tx
      .select({ start: sessions.scheduledStart })
      .from(sessions)
      .where(eq(sessions.eventId, eventId))
      .orderBy(asc(sessions.scheduledStart))
      .limit(1);
    const report: EventEntriesReport = { inserted: 0, updated: 0, removed: 0 };
    if (!first) return report;
    const day = localDate(first.start, event.timezone);

    const seats = await tx
      .select()
      .from(seatAssignments)
      .where(
        and(
          eq(seatAssignments.seasonId, event.seasonId),
          eq(seatAssignments.role, "race"),
          lte(seatAssignments.validFrom, day),
          or(
            isNull(seatAssignments.validTo),
            gte(seatAssignments.validTo, day),
          ),
        ),
      );
    const entries = await tx
      .select()
      .from(eventEntries)
      .where(eq(eventEntries.eventId, eventId));
    const entryByDriver = new Map(entries.map((e) => [e.driverId, e]));
    const seatDrivers = new Set(seats.map((s) => s.driverId));

    for (const seat of seats) {
      const entry = entryByDriver.get(seat.driverId);
      if (!entry) {
        await tx.insert(eventEntries).values({
          eventId,
          driverId: seat.driverId,
          constructorId: seat.constructorId,
          carNumber: seat.carNumber,
          source: "seat",
          ...(now ? { createdAt: now, updatedAt: now } : {}),
        });
        report.inserted += 1;
      } else if (
        entry.source === "seat" &&
        (entry.constructorId !== seat.constructorId ||
          entry.carNumber !== seat.carNumber)
      ) {
        await tx
          .update(eventEntries)
          .set({
            constructorId: seat.constructorId,
            carNumber: seat.carNumber,
            ...(now ? { updatedAt: now } : {}),
          })
          .where(
            and(
              eq(eventEntries.eventId, eventId),
              eq(eventEntries.driverId, seat.driverId),
            ),
          );
        report.updated += 1;
      }
    }

    for (const entry of entries) {
      if (entry.source === "seat" && !seatDrivers.has(entry.driverId)) {
        await tx
          .delete(eventEntries)
          .where(
            and(
              eq(eventEntries.eventId, eventId),
              eq(eventEntries.driverId, entry.driverId),
            ),
          );
        report.removed += 1;
      }
    }
    return report;
  });
}
