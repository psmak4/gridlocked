import { and, asc, eq, inArray, min, ne } from "drizzle-orm";
import { writeAudit } from "@/audit/log";
import {
  circuits,
  constructorSeasons,
  constructors,
  driverAvailability,
  drivers,
  eventEntries,
  events,
  gameEvents,
  games,
  poolAssets,
  seasons,
  seatAssignments,
  sessions,
  teams,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { lockedLineups } from "@/game/lineups";
import {
  type AvailabilityStatus,
  notifyAvailability,
} from "@/notifications/availability";
import { constructorCode } from "@/play/builder";
import { localDate } from "@/reference/sync-event-entries";
import { StaffError, staffReason } from "./errors";
import { audit, type StaffActor } from "./roster";

// Drivers, seats and availability for staff (M8 Task 6, HLD §8, DM 1.8 and
// 1.10). Seats change through `changeSeats` and `recordSubstitution`
// (./roster); this file adds availability, which is warnings only (points
// always come from the results), and the screen's reads.

export const AVAILABILITY_STATUSES = [
  "available",
  "doubtful",
  "unavailable",
  "reserve",
] as const satisfies readonly AvailabilityStatus[];

const driverName = (d: { displayName: string | null; familyName: string }) =>
  d.displayName ?? d.familyName;

/**
 * Sets a driver's availability for an event, with the note players see.
 * A change of status notifies the driver's owners (`notifyAvailability`);
 * a change of note alone doesn't. Returns how many people were told.
 * Refuses, writing nothing: a blank reason, an event or driver that isn't
 * there, a cancelled or completed event (`invalid`), and one that has locked
 * (`event_locked`). The same status and note again writes nothing.
 * `afterLock` is the review queue's "Mark unavailable" for a driver missing
 * from results: it records the status on a locked or completed event too,
 * and tells nobody, since the event is past.
 */
export async function setAvailability(
  db: Db,
  now: Date,
  actor: StaffActor,
  input: {
    eventId: string;
    driverId: string;
    status: AvailabilityStatus;
    note: string;
    reason: string;
  },
  options: { afterLock?: boolean } = {},
): Promise<{ owners: number }> {
  const reason = staffReason(input.reason);
  if (!(AVAILABILITY_STATUSES as readonly string[]).includes(input.status)) {
    throw new StaffError("invalid");
  }
  const note = input.note.trim() || null;
  const { eventId, driverId, status } = input;
  return db.transaction(async (tx) => {
    const [event] = await tx
      .select({ status: events.status, lockAt: events.lockAt })
      .from(events)
      .where(eq(events.id, eventId))
      .for("update");
    if (!event) throw new StaffError("not_found");
    const past = event.lockAt <= now || event.status === "completed";
    if (options.afterLock) {
      if (event.status === "cancelled") throw new StaffError("invalid");
    } else {
      if (event.status !== "scheduled") throw new StaffError("invalid");
      if (past) throw new StaffError("event_locked");
    }
    const [driver] = await tx
      .select({ id: drivers.id })
      .from(drivers)
      .where(eq(drivers.id, driverId));
    if (!driver) throw new StaffError("not_found");

    const [existing] = await tx
      .select()
      .from(driverAvailability)
      .where(
        and(
          eq(driverAvailability.eventId, eventId),
          eq(driverAvailability.driverId, driverId),
        ),
      );
    if (existing && existing.status === status && existing.reason === note) {
      return { owners: 0 };
    }
    const row = { status, reason: note, source: "admin" as const };
    await tx
      .insert(driverAvailability)
      .values({ eventId, driverId, ...row, updatedAt: now })
      .onConflictDoUpdate({
        target: [driverAvailability.eventId, driverAvailability.driverId],
        set: { ...row, updatedAt: now },
      });
    await writeAudit(tx, now, {
      ...audit(actor, reason),
      action: "driver_availability.update",
      entityType: "driver_availability",
      entityId: eventId,
      before: existing
        ? { driverId, status: existing.status, note: existing.reason }
        : null,
      after: { driverId, status, note },
    });
    if (existing?.status === status || past) return { owners: 0 };
    return {
      owners: await notifyAvailability(tx, now, { eventId, driverId, status }),
    };
  });
}

// --- The screen's reads -------------------------------------------------------

const dayMonth = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});
/** "6 Mar" for "2026-03-06". */
const dayWords = (day: string) => dayMonth.format(new Date(`${day}T00:00:00Z`));

/** The season's events that aren't cancelled, by the local day each starts. */
async function eventDays(
  db: Db,
  seasonId: string,
): Promise<
  { id: string; round: number; name: string; day: string; lockAt: Date }[]
> {
  const rows = await db
    .select({
      id: events.id,
      round: events.round,
      name: events.name,
      lockAt: events.lockAt,
      timezone: circuits.timezone,
      first: min(sessions.scheduledStart),
    })
    .from(events)
    .innerJoin(circuits, eq(circuits.id, events.circuitId))
    .innerJoin(sessions, eq(sessions.eventId, events.id))
    .where(and(eq(events.seasonId, seasonId), ne(events.status, "cancelled")))
    .groupBy(events.id, circuits.timezone)
    .orderBy(asc(events.round));
  return rows.map((r) => ({
    id: r.id,
    round: r.round,
    name: r.name,
    lockAt: r.lockAt,
    day: localDate(new Date(r.first!), r.timezone ?? "UTC"),
  }));
}

export type SeatTeam = {
  id: string;
  slug: string;
  name: string;
  code: string;
  color: string;
};

export type SeatRow = {
  id: string;
  driverId: string;
  driver: string;
  /** The team's slug. */
  team: string;
  code: string;
  color: string;
  carNumber: number;
  role: "Race" | "Reserve";
  /** "21 Aug (rd 12)". */
  from: string;
  /** "13 Sep (rd 14)", or "Open". */
  until: string;
};

export type SeatTable = {
  season: number;
  teams: SeatTeam[];
  seats: SeatRow[];
};

/**
 * The season's seats as date ranges, each with the first and last round it
 * covers, an open-ended one "Open". `team` (a constructor's slug) keeps one
 * team's tab.
 */
export async function seatTable(
  db: Db,
  seasonYear: number,
  team?: string,
): Promise<SeatTable> {
  const [season] = await db
    .select({ id: seasons.id })
    .from(seasons)
    .where(eq(seasons.year, seasonYear));
  if (!season) return { season: seasonYear, teams: [], seats: [] };
  const teamRows = await db
    .select({
      id: constructors.id,
      slug: constructors.slug,
      name: constructorSeasons.displayName,
      shortName: constructorSeasons.shortName,
      color: constructorSeasons.color,
    })
    .from(constructorSeasons)
    .innerJoin(
      constructors,
      eq(constructors.id, constructorSeasons.constructorId),
    )
    .where(eq(constructorSeasons.seasonId, season.id))
    .orderBy(asc(constructorSeasons.displayName));
  const byId = new Map(teamRows.map((tm) => [tm.id, tm]));
  const days = await eventDays(db, season.id);

  const seatRows = await db
    .select({
      id: seatAssignments.id,
      driverId: seatAssignments.driverId,
      constructorId: seatAssignments.constructorId,
      carNumber: seatAssignments.carNumber,
      role: seatAssignments.role,
      validFrom: seatAssignments.validFrom,
      validTo: seatAssignments.validTo,
      familyName: drivers.familyName,
      displayName: drivers.displayName,
    })
    .from(seatAssignments)
    .innerJoin(drivers, eq(drivers.id, seatAssignments.driverId))
    .where(eq(seatAssignments.seasonId, season.id))
    .orderBy(asc(seatAssignments.validFrom), asc(drivers.familyName));

  const seats: SeatRow[] = [];
  for (const s of seatRows) {
    const tm = byId.get(s.constructorId);
    if (!tm || (team && tm.slug !== team)) continue;
    const covered = days.filter(
      (e) => e.day >= s.validFrom && (s.validTo === null || e.day <= s.validTo),
    );
    const first = covered[0];
    const last = covered[covered.length - 1];
    seats.push({
      id: s.id,
      driverId: s.driverId,
      driver: driverName(s),
      team: tm.slug,
      code: constructorCode(tm.shortName),
      color: tm.color,
      carNumber: s.carNumber,
      role: s.role === "race" ? "Race" : "Reserve",
      from: `${dayWords(s.validFrom)}${first ? ` (rd ${first.round})` : ""}`,
      until:
        s.validTo === null
          ? "Open"
          : `${dayWords(s.validTo)}${last ? ` (rd ${last.round})` : ""}`,
    });
  }
  // Grouped by team, in the tabs' order.
  const order = new Map(teamRows.map((tm, i) => [tm.slug, i]));
  seats.sort((a, b) => order.get(a.team)! - order.get(b.team)!);
  return {
    season: seasonYear,
    teams: teamRows.map((tm) => ({
      id: tm.id,
      slug: tm.slug,
      name: tm.name,
      code: constructorCode(tm.shortName),
      color: tm.color,
    })),
    seats,
  };
}

export type AvailabilityRow = {
  driverId: string;
  driver: string;
  code: string;
  color: string;
  status: AvailabilityStatus;
  note: string | null;
  /** Active teams whose lineup for the event has him. */
  teams: number;
};

export type EventAvailability = {
  event: { id: string; round: number; name: string; locked: boolean };
  /** Active teams in the running games: what the shares are out of. */
  teams: number;
  drivers: AvailabilityRow[];
};

/** Each entered driver's availability for an event, with how many teams have him. */
export async function availabilityFor(
  db: Db,
  now: Date,
  eventId: string,
): Promise<EventAvailability> {
  const [event] = await db
    .select({
      id: events.id,
      round: events.round,
      name: events.name,
      lockAt: events.lockAt,
      seasonId: events.seasonId,
    })
    .from(events)
    .where(eq(events.id, eventId));
  if (!event) throw new StaffError("not_found");

  const entries = await db
    .select({
      driverId: eventEntries.driverId,
      familyName: drivers.familyName,
      displayName: drivers.displayName,
      shortName: constructorSeasons.shortName,
      color: constructorSeasons.color,
      status: driverAvailability.status,
      note: driverAvailability.reason,
    })
    .from(eventEntries)
    .innerJoin(drivers, eq(drivers.id, eventEntries.driverId))
    .innerJoin(
      constructorSeasons,
      and(
        eq(constructorSeasons.constructorId, eventEntries.constructorId),
        eq(constructorSeasons.seasonId, event.seasonId),
      ),
    )
    .leftJoin(
      driverAvailability,
      and(
        eq(driverAvailability.eventId, eventEntries.eventId),
        eq(driverAvailability.driverId, eventEntries.driverId),
      ),
    )
    .where(eq(eventEntries.eventId, eventId))
    .orderBy(asc(constructorSeasons.displayName), asc(drivers.familyName));

  // How many teams have each driver, over the running games' lineups.
  const owned = new Map<string, number>();
  let total = 0;
  const gameRows = await db
    .select({ id: games.id })
    .from(gameEvents)
    .innerJoin(games, eq(games.id, gameEvents.gameId))
    .where(
      and(
        eq(gameEvents.eventId, eventId),
        inArray(games.status, ["open", "running"]),
      ),
    );
  for (const { id: gameId } of gameRows) {
    const gameTeams = await db
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.gameId, gameId), eq(teams.status, "active")));
    total += gameTeams.length;
    const driverOf = new Map(
      (
        await db
          .select({ id: poolAssets.id, driverId: poolAssets.driverId })
          .from(poolAssets)
          .where(eq(poolAssets.gameId, gameId))
      ).map((a) => [a.id, a.driverId]),
    );
    const lineups = await lockedLineups(db, {
      eventId,
      teamIds: gameTeams.map((tm) => tm.id),
    });
    for (const lineup of lineups.values()) {
      for (const pick of lineup.picks) {
        const driverId = driverOf.get(pick.assetId);
        if (driverId) owned.set(driverId, (owned.get(driverId) ?? 0) + 1);
      }
    }
  }

  return {
    event: {
      id: event.id,
      round: event.round,
      name: event.name,
      locked: event.lockAt <= now,
    },
    teams: total,
    drivers: entries.map((e) => ({
      driverId: e.driverId,
      driver: driverName(e),
      code: constructorCode(e.shortName),
      color: e.color,
      status: e.status ?? "available",
      note: e.note,
      teams: owned.get(e.driverId) ?? 0,
    })),
  };
}

/** The event the availability panel opens on: the next one to lock. */
export async function nextEventId(
  db: Db,
  now: Date,
  seasonYear: number,
): Promise<string | null> {
  const [season] = await db
    .select({ id: seasons.id })
    .from(seasons)
    .where(eq(seasons.year, seasonYear));
  if (!season) return null;
  const upcoming = (await eventDays(db, season.id))
    .filter((e) => e.lockAt > now)
    .sort((a, b) => a.lockAt.getTime() - b.lockAt.getTime());
  return upcoming[0]?.id ?? null;
}

/** The season's events for the seat forms' "from" choice: those not locked. */
export async function seatEvents(
  db: Db,
  now: Date,
  seasonYear: number,
): Promise<{ id: string; round: number; name: string; day: string }[]> {
  const [season] = await db
    .select({ id: seasons.id })
    .from(seasons)
    .where(eq(seasons.year, seasonYear));
  if (!season) return [];
  return (await eventDays(db, season.id))
    .filter((e) => e.lockAt > now)
    .map(({ id, round, name, day }) => ({ id, round, name, day }));
}

/** The drivers the seat forms offer: anyone seated or entered this season. */
export async function seasonDrivers(
  db: Db,
  seasonYear: number,
): Promise<{ id: string; name: string }[]> {
  const [season] = await db
    .select({ id: seasons.id })
    .from(seasons)
    .where(eq(seasons.year, seasonYear));
  if (!season) return [];
  const seated = db
    .selectDistinct({ id: seatAssignments.driverId })
    .from(seatAssignments)
    .where(eq(seatAssignments.seasonId, season.id));
  const entered = db
    .selectDistinct({ id: eventEntries.driverId })
    .from(eventEntries)
    .innerJoin(events, eq(events.id, eventEntries.eventId))
    .where(eq(events.seasonId, season.id));
  const ids = new Set([...(await seated), ...(await entered)].map((r) => r.id));
  if (ids.size === 0) return [];
  const rows = await db
    .select({
      id: drivers.id,
      givenName: drivers.givenName,
      familyName: drivers.familyName,
      displayName: drivers.displayName,
    })
    .from(drivers)
    .where(inArray(drivers.id, [...ids]))
    .orderBy(asc(drivers.familyName));
  return rows.map((d) => ({
    id: d.id,
    name: d.displayName ?? `${d.givenName} ${d.familyName}`,
  }));
}
