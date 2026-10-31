import { and, asc, eq, gte, isNull, or } from "drizzle-orm";
import { writeAudit } from "@/audit/log";
import {
  circuits,
  driverAvailability,
  eventEntries,
  events,
  seatAssignments,
  sessions,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { newId } from "@/lib/ids";
import { localDate, syncEventEntries } from "@/reference/sync-event-entries";
import {
  revalidateEvent,
  type SessionMove,
  type StaffDeps,
} from "./revalidate";

// Staff actions for roster changes (HLD §8). Each writes its change and its
// audit rows in one transaction (DM 0.4), then checks the event again so a
// held session moves at once instead of at the next finalize check. Until
// M8's screens, they run through `pnpm staff` (scripts/staff.ts).

/** Who is acting. `label` stands in for a user until M5 (the GitHub login). */
export interface StaffActor {
  kind: "admin";
  label: string;
  /** Ties the audit rows of one run together, e.g. `gh-run:<id>`. */
  requestId?: string;
}

/** The fields of `after` that differ from `before`, as a pair for the audit. */
function changes(
  before: Record<string, unknown> | null,
  after: Record<string, unknown>,
): {
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
} | null {
  if (!before) return { before: null, after };
  const keys = Object.keys(after).filter((k) => before[k] !== after[k]);
  if (keys.length === 0) return null;
  return {
    before: Object.fromEntries(keys.map((k) => [k, before[k]])),
    after: Object.fromEntries(keys.map((k) => [k, after[k]])),
  };
}

function requireReason(reason: string): string {
  const trimmed = reason.trim();
  if (!trimmed) throw new Error("a staff action needs a reason");
  return trimmed;
}

const audit = (actor: StaffActor, reason: string) => ({
  actorKind: actor.kind,
  actorLabel: actor.label,
  reason,
  requestId: actor.requestId ?? null,
});

/**
 * A substitution for one event only (HLD §8.1, DM 1.9): `inDriverId` drives
 * for `constructorId` in car `carNumber` at this event, and `outDriverId`, if
 * given, is unavailable for it. The substitute gets an `admin` entry, which
 * the seat sync never touches; the replaced driver keeps his seat entry, since
 * both drivers take part in the weekend and share the team's two cars.
 *
 * Refuses, writing nothing: a blank reason, an out driver with no entry at
 * that constructor, and a car number another constructor's entry already
 * uses at the event. Running it again with the same input changes nothing and
 * writes no audit row (`changed: false`); the event is checked again either
 * way.
 */
export async function recordSubstitution(
  db: Db,
  now: Date,
  input: {
    eventId: string;
    inDriverId: string;
    constructorId: string;
    carNumber: number;
    outDriverId: string | null;
    reason: string;
    actor: StaffActor;
  },
  deps: StaffDeps = {},
): Promise<{ changed: boolean; sessions: SessionMove[] }> {
  const reason = requireReason(input.reason);
  const { eventId, inDriverId, constructorId, carNumber, outDriverId } = input;
  const meta = audit(input.actor, reason);

  const changed = await db.transaction(async (tx) => {
    const [event] = await tx
      .select({ id: events.id })
      .from(events)
      .where(eq(events.id, eventId));
    if (!event) throw new Error(`no event ${eventId}`);

    const entries = await tx
      .select()
      .from(eventEntries)
      .where(eq(eventEntries.eventId, eventId));
    if (outDriverId) {
      const out = entries.find((e) => e.driverId === outDriverId);
      if (!out || out.constructorId !== constructorId) {
        throw new Error(
          `driver ${outDriverId} is not entered for constructor ${constructorId} at this event`,
        );
      }
    }
    const clash = entries.find(
      (e) =>
        e.carNumber === carNumber &&
        e.constructorId !== constructorId &&
        e.driverId !== inDriverId,
    );
    if (clash) {
      throw new Error(
        `car ${carNumber} is already entered for constructor ${clash.constructorId} at this event`,
      );
    }

    let wrote = false;
    const current = entries.find((e) => e.driverId === inDriverId);
    const entry = { constructorId, carNumber, source: "admin" as const };
    const entryChange = changes(
      current
        ? {
            constructorId: current.constructorId,
            carNumber: current.carNumber,
            source: current.source,
          }
        : null,
      entry,
    );
    if (entryChange) {
      if (current) {
        await tx
          .update(eventEntries)
          .set({ ...entry, updatedAt: now })
          .where(
            and(
              eq(eventEntries.eventId, eventId),
              eq(eventEntries.driverId, inDriverId),
            ),
          );
      } else {
        await tx.insert(eventEntries).values({
          eventId,
          driverId: inDriverId,
          ...entry,
          createdAt: now,
          updatedAt: now,
        });
      }
      await writeAudit(tx, now, {
        ...meta,
        action: current ? "event_entry.update" : "event_entry.create",
        entityType: "event_entry",
        entityId: eventId,
        before: entryChange.before && {
          driverId: inDriverId,
          ...entryChange.before,
        },
        after: { driverId: inDriverId, ...entryChange.after },
      });
      wrote = true;
    }

    if (outDriverId) {
      const [existing] = await tx
        .select()
        .from(driverAvailability)
        .where(
          and(
            eq(driverAvailability.eventId, eventId),
            eq(driverAvailability.driverId, outDriverId),
          ),
        );
      const availability = {
        status: "unavailable" as const,
        reason,
        source: "admin" as const,
      };
      const availabilityChange = changes(
        existing
          ? {
              status: existing.status,
              reason: existing.reason,
              source: existing.source,
            }
          : null,
        availability,
      );
      if (availabilityChange) {
        await tx
          .insert(driverAvailability)
          .values({
            eventId,
            driverId: outDriverId,
            ...availability,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [driverAvailability.eventId, driverAvailability.driverId],
            set: { ...availability, updatedAt: now },
          });
        await writeAudit(tx, now, {
          ...meta,
          action: "driver_availability.update",
          entityType: "driver_availability",
          entityId: eventId,
          before: availabilityChange.before && {
            driverId: outDriverId,
            ...availabilityChange.before,
          },
          after: { driverId: outDriverId, ...availabilityChange.after },
        });
        wrote = true;
      }
    }
    return wrote;
  });

  return {
    changed,
    sessions: await revalidateEvent(db, now, eventId, deps),
  };
}

/** True when `seat` is exactly the open-ended race seat `change` opens on `day`. */
function alreadyOpen(
  seat: {
    constructorId: string;
    carNumber: number;
    role: string;
    validFrom: string;
    validTo: string | null;
  },
  change: { constructorId: string | null; carNumber?: number },
  day: string,
): boolean {
  return (
    seat.role === "race" &&
    seat.validTo === null &&
    seat.validFrom === day &&
    seat.constructorId === change.constructorId &&
    seat.carNumber === change.carNumber
  );
}

/** `YYYY-MM-DD` one day before `day`. */
function dayBefore(day: string): string {
  const d = new Date(`${day}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** The local date of an event's first session, or null if it has none. */
async function firstDay(tx: Db, eventId: string): Promise<string | null> {
  const [first] = await tx
    .select({ start: sessions.scheduledStart, timezone: circuits.timezone })
    .from(sessions)
    .innerJoin(events, eq(events.id, sessions.eventId))
    .innerJoin(circuits, eq(circuits.id, events.circuitId))
    .where(eq(sessions.eventId, eventId))
    .orderBy(asc(sessions.scheduledStart))
    .limit(1);
  return first ? localDate(first.start, first.timezone) : null;
}

/**
 * A seat change from an event onward (DM 1.8): from the local date of
 * `fromEventId`'s first session, each driver's active race seat closes the
 * day before, and a race seat opens wherever `constructorId` is set
 * (`carNumber` is then required). `constructorId: null` only ends the seat.
 * History is never edited: a seat that starts on or after the date is
 * refused, except the very seat this change opens: running it again (a retry)
 * changes nothing and writes no audit row. Then the entries of every
 * scheduled event of the season from that date are synced again, and the from
 * event is checked again. All writes and their audit rows are one transaction.
 */
export async function changeSeats(
  db: Db,
  now: Date,
  input: {
    fromEventId: string;
    changes: Array<{
      driverId: string;
      constructorId: string | null;
      carNumber?: number;
    }>;
    reason: string;
    actor: StaffActor;
  },
  deps: StaffDeps = {},
): Promise<{ eventsSynced: number; sessions: SessionMove[] }> {
  const reason = requireReason(input.reason);
  const meta = audit(input.actor, reason);

  const eventsSynced = await db.transaction(async (tx) => {
    const [from] = await tx
      .select({ seasonId: events.seasonId })
      .from(events)
      .where(eq(events.id, input.fromEventId));
    if (!from) throw new Error(`no event ${input.fromEventId}`);
    const day = await firstDay(tx, input.fromEventId);
    if (!day) throw new Error(`event ${input.fromEventId} has no sessions`);

    // Every close first, so a car number or a driver freed here can be taken.
    for (const change of input.changes) {
      const active = await tx
        .select()
        .from(seatAssignments)
        .where(
          and(
            eq(seatAssignments.seasonId, from.seasonId),
            eq(seatAssignments.driverId, change.driverId),
            eq(seatAssignments.role, "race"),
            or(
              isNull(seatAssignments.validTo),
              gte(seatAssignments.validTo, day),
            ),
          ),
        );
      for (const seat of active) {
        if (alreadyOpen(seat, change, day)) continue;
        if (seat.validFrom >= day) {
          throw new Error(
            `driver ${change.driverId}'s race seat starts on or after ${day}; changing a future seat is not supported`,
          );
        }
        const validTo = dayBefore(day);
        await tx
          .update(seatAssignments)
          .set({ validTo, updatedAt: now })
          .where(eq(seatAssignments.id, seat.id));
        await writeAudit(tx, now, {
          ...meta,
          action: "seat_assignment.close",
          entityType: "seat_assignment",
          entityId: seat.id,
          before: { validTo: seat.validTo },
          after: { validTo },
        });
      }
    }
    for (const change of input.changes) {
      if (!change.constructorId) continue;
      if (change.carNumber === undefined) {
        throw new Error(
          `a new seat for driver ${change.driverId} needs a car number`,
        );
      }
      const [open] = await tx
        .select()
        .from(seatAssignments)
        .where(
          and(
            eq(seatAssignments.seasonId, from.seasonId),
            eq(seatAssignments.driverId, change.driverId),
            eq(seatAssignments.role, "race"),
            eq(seatAssignments.validFrom, day),
          ),
        );
      if (open && alreadyOpen(open, change, day)) continue;
      const seat = {
        id: newId(),
        seasonId: from.seasonId,
        driverId: change.driverId,
        constructorId: change.constructorId,
        carNumber: change.carNumber,
        role: "race" as const,
        validFrom: day,
        validTo: null,
      };
      await tx
        .insert(seatAssignments)
        .values({ ...seat, createdAt: now, updatedAt: now });
      await writeAudit(tx, now, {
        ...meta,
        action: "seat_assignment.open",
        entityType: "seat_assignment",
        entityId: seat.id,
        before: null,
        after: {
          driverId: seat.driverId,
          constructorId: seat.constructorId,
          carNumber: seat.carNumber,
          role: seat.role,
          validFrom: seat.validFrom,
        },
      });
    }

    const scheduled = await tx
      .select({ id: events.id })
      .from(events)
      .where(
        and(eq(events.seasonId, from.seasonId), eq(events.status, "scheduled")),
      );
    let synced = 0;
    for (const e of scheduled) {
      const first = await firstDay(tx, e.id);
      if (!first || first < day) continue;
      await syncEventEntries(tx, e.id, now);
      synced += 1;
    }
    return synced;
  });

  return {
    eventsSynced,
    sessions: await revalidateEvent(db, now, input.fromEventId, deps),
  };
}
