import { and, asc, desc, eq, inArray, max, min, ne, sql } from "drizzle-orm";
import { writeAudit } from "@/audit/log";
import { auditPage, type AuditRow } from "@/audit/read";
import {
  circuits,
  events,
  gameEvents,
  games,
  gameSessionExceptions,
  jobs,
  seasons,
  sessions,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { moveChatWindow } from "@/community/session-threads";
import {
  clearSessionException,
  setSessionException,
} from "@/game/cancellations";
import { planGameEvents } from "@/game/games";
import { planGameJobs } from "@/game/jobs";
import { type DueStore, publishDueTimes } from "@/jobs/due-times";
import { planEventJobs } from "@/jobs/plan-event";
import type { TickDb } from "@/jobs/tick";
import { SESSION_LABELS } from "@/play/weekend";
import {
  type EventBadge,
  eventBadge,
  STAFF_SESSION_STATUSES,
  type StaffSessionStatus,
  utcDates,
  utcLock,
} from "./calendar-words";
import { StaffError, staffReason } from "./errors";
import { audit, type StaffActor } from "./roster";

// The calendar's staff actions (M8 Task 5, HLD §8, DM 1.3 and 1.4): a lock
// time set by hand or put back on its session, a session's times and status,
// and an event cancelled before its lock. Each writes its change and its audit
// rows in one transaction, then plans again, as the daily calendar sync does:
// the event's jobs, then every game of the season (its events, which refunds
// chips for a cancelled event, and its lock and open jobs). The sync leaves a
// lock set by hand (`lock_at_source = 'admin'`) and times set by hand
// (`time_source = 'admin'`) alone.
//
// When the caller has the due-times store, the file is rebuilt from the job
// table after planning, so a lock moved earlier wakes the tick in time. The
// site has no store when deployed (the tick runs elsewhere), so it relies on
// the 6-hourly safety tick and on the lock job's own check of `lock_at`.

export { STAFF_SESSION_STATUSES, type StaffSessionStatus };

const lockState = (e: { lockAt: Date; lockAtSource: string }) => ({
  lockAt: e.lockAt.toISOString(),
  lockAtSource: e.lockAtSource,
});

async function lockedEvent(db: Db, eventId: string) {
  const [event] = await db
    .select()
    .from(events)
    .where(eq(events.id, eventId))
    .for("update");
  if (!event) throw new StaffError("not_found");
  return event;
}

/** Plans the event and every game of its season again, as the sync does. */
async function replan(
  db: Db,
  now: Date,
  eventId: string,
  store?: DueStore,
): Promise<void> {
  await planEventJobs(db, eventId);
  const seasonGames = await db
    .select({ id: games.id })
    .from(games)
    .innerJoin(events, eq(events.seasonId, games.seasonId))
    .where(eq(events.id, eventId))
    .orderBy(asc(games.id));
  for (const { id } of seasonGames) {
    await planGameEvents(db, now, id);
    await planGameJobs(db, now, id);
  }
  if (store) await publishDueTimes(db as TickDb, store, now);
}

/**
 * Sets an event's lock by hand. Refuses, writing nothing: a blank reason, an
 * event that isn't there or is cancelled, a lock that has passed, and a new
 * time that has passed.
 */
export async function setLockAt(
  db: Db,
  now: Date,
  actor: StaffActor,
  input: { eventId: string; lockAt: Date; reason: string },
  store?: DueStore,
): Promise<void> {
  const reason = staffReason(input.reason);
  await db.transaction(async (tx) => {
    const event = await lockedEvent(tx, input.eventId);
    if (event.status !== "scheduled") throw new StaffError("invalid");
    if (event.lockAt <= now || input.lockAt <= now) {
      throw new StaffError("lock_in_past");
    }
    await tx
      .update(events)
      .set({ lockAt: input.lockAt, lockAtSource: "admin", updatedAt: now })
      .where(eq(events.id, event.id));
    await writeAudit(tx, now, {
      ...audit(actor, reason),
      action: "event.lock_at.update",
      entityType: "event",
      entityId: event.id,
      before: lockState(event),
      after: lockState({ lockAt: input.lockAt, lockAtSource: "admin" }),
    });
  });
  await replan(db, now, input.eventId, store);
}

/** Where a default lock sits: its session's start, else the first session's. */
async function defaultLockAt(
  db: Db,
  event: { id: string; lockSessionId: string | null },
): Promise<Date | null> {
  const rows = await db
    .select({ id: sessions.id, start: sessions.scheduledStart })
    .from(sessions)
    .where(
      and(eq(sessions.eventId, event.id), ne(sessions.status, "cancelled")),
    )
    .orderBy(asc(sessions.scheduledStart));
  const lock = rows.find((s) => s.id === event.lockSessionId);
  return (lock ?? rows[0])?.start ?? null;
}

/**
 * Puts an event's lock back on its session's start, so the sync moves it
 * again. Refuses, writing nothing: a blank reason, an event that isn't there
 * or is cancelled, a lock that has passed, and a session start that has.
 */
export async function followLockSession(
  db: Db,
  now: Date,
  actor: StaffActor,
  input: { eventId: string; reason: string },
  store?: DueStore,
): Promise<void> {
  const reason = staffReason(input.reason);
  await db.transaction(async (tx) => {
    const event = await lockedEvent(tx, input.eventId);
    if (event.status !== "scheduled") throw new StaffError("invalid");
    const wanted = await defaultLockAt(tx, event);
    if (!wanted) throw new StaffError("invalid");
    if (event.lockAt <= now || wanted <= now) {
      throw new StaffError("lock_in_past");
    }
    await tx
      .update(events)
      .set({ lockAt: wanted, lockAtSource: "default", updatedAt: now })
      .where(eq(events.id, event.id));
    await writeAudit(tx, now, {
      ...audit(actor, reason),
      action: "event.lock_at.update",
      entityType: "event",
      entityId: event.id,
      before: lockState(event),
      after: lockState({ lockAt: wanted, lockAtSource: "default" }),
    });
  });
  await replan(db, now, input.eventId, store);
}

/**
 * Sets a session's times by hand (`time_source = 'admin'`, which the sync
 * keeps), moving its thread's chat window with it. A default lock on this
 * session that hasn't passed moves too, audited as a lock change. Refuses,
 * writing nothing: a blank reason, a session that isn't there, a start at or
 * after its end, and a move that would put an unpassed lock in the past.
 */
export async function setSessionTimes(
  db: Db,
  now: Date,
  actor: StaffActor,
  input: { sessionId: string; start: Date; end: Date; reason: string },
  store?: DueStore,
): Promise<void> {
  const reason = staffReason(input.reason);
  const { start, end } = input;
  if (
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    start >= end
  ) {
    throw new StaffError("invalid");
  }
  const eventId = await db.transaction(async (tx) => {
    const [session] = await tx
      .select()
      .from(sessions)
      .where(eq(sessions.id, input.sessionId));
    if (!session) throw new StaffError("not_found");
    const event = await lockedEvent(tx, session.eventId);
    const lockMoves =
      event.lockSessionId === session.id &&
      event.lockAtSource === "default" &&
      event.lockAt > now &&
      event.lockAt.getTime() !== start.getTime();
    if (lockMoves && start <= now) throw new StaffError("lock_in_past");

    await tx
      .update(sessions)
      .set({
        scheduledStart: start,
        scheduledEnd: end,
        timeSource: "admin",
        updatedAt: now,
      })
      .where(eq(sessions.id, session.id));
    await moveChatWindow(tx, {
      id: session.id,
      scheduledStart: start,
      scheduledEnd: end,
    });
    const meta = audit(actor, reason);
    await writeAudit(tx, now, {
      ...meta,
      action: "session.times.update",
      entityType: "session",
      entityId: session.id,
      before: {
        scheduledStart: session.scheduledStart.toISOString(),
        scheduledEnd: session.scheduledEnd.toISOString(),
        timeSource: session.timeSource,
      },
      after: {
        scheduledStart: start.toISOString(),
        scheduledEnd: end.toISOString(),
        timeSource: "admin",
      },
    });
    if (lockMoves) {
      await tx
        .update(events)
        .set({ lockAt: start, updatedAt: now })
        .where(eq(events.id, event.id));
      await writeAudit(tx, now, {
        ...meta,
        action: "event.lock_at.update",
        entityType: "event",
        entityId: event.id,
        before: lockState(event),
        after: lockState({ lockAt: start, lockAtSource: "default" }),
      });
    }
    return event.id;
  });
  await replan(db, now, eventId, store);
}

/** The games of the season that are running and have this event. */
async function runningGames(db: Db, eventId: string): Promise<string[]> {
  const rows = await db
    .select({ id: games.id })
    .from(games)
    .innerJoin(gameEvents, eq(gameEvents.gameId, games.id))
    .where(
      and(
        eq(gameEvents.eventId, eventId),
        inArray(games.status, ["open", "running"]),
      ),
    )
    .orderBy(asc(games.id));
  return rows.map((r) => r.id);
}

/**
 * Sets a session's status. `cancelled` leaves the session out of scoring for
 * every running game (a `skip` exception, unless the game has one already)
 * and its thread gets no results post; back from `cancelled`, those `skip`
 * exceptions are cleared. `suspended` keeps the session's chat open past its
 * end. `abandoned` scores as classified unless an admin sets an exception on
 * the results screens. Refuses, writing nothing: a blank reason, a status
 * staff don't set (`live` and `completed` are the clock's), and a session
 * that isn't there. Setting the status it has changes nothing.
 */
export async function setSessionStatus(
  db: Db,
  now: Date,
  actor: StaffActor,
  input: { sessionId: string; status: StaffSessionStatus; reason: string },
  store?: DueStore,
): Promise<void> {
  const reason = staffReason(input.reason);
  const { status } = input;
  if (!(STAFF_SESSION_STATUSES as readonly string[]).includes(status)) {
    throw new StaffError("invalid");
  }
  const changed = await db.transaction(async (tx) => {
    const [session] = await tx
      .select()
      .from(sessions)
      .where(eq(sessions.id, input.sessionId))
      .for("update");
    if (!session) throw new StaffError("not_found");
    if (session.status === status) return null;
    await tx
      .update(sessions)
      .set({ status, updatedAt: now })
      .where(eq(sessions.id, session.id));
    await writeAudit(tx, now, {
      ...audit(actor, reason),
      action: "session.status.update",
      entityType: "session",
      entityId: session.id,
      before: { status: session.status },
      after: { status },
    });
    return { eventId: session.eventId, was: session.status };
  });
  if (!changed) return;

  const { sessionId } = input;
  const exceptions = new Map(
    (
      await db
        .select({
          gameId: gameSessionExceptions.gameId,
          policy: gameSessionExceptions.policy,
        })
        .from(gameSessionExceptions)
        .where(eq(gameSessionExceptions.sessionId, sessionId))
    ).map((x) => [x.gameId, x.policy]),
  );
  for (const gameId of await runningGames(db, changed.eventId)) {
    if (status === "cancelled" && !exceptions.has(gameId)) {
      await setSessionException(db, now, {
        gameId,
        sessionId,
        policy: "skip",
        reason,
        actor,
      });
    } else if (
      changed.was === "cancelled" &&
      exceptions.get(gameId) === "skip"
    ) {
      await clearSessionException(db, now, {
        gameId,
        sessionId,
        reason,
        actor,
      });
    }
  }
  await replan(db, now, changed.eventId, store);
}

/**
 * Cancels an event before its lock (DM 3.9): the event and all its sessions
 * become `cancelled`, and planning again refunds the chips played for it and
 * opens the next event if it was the open one. Refuses, writing nothing: a
 * blank reason, an event that isn't there, and one that has locked
 * (`event_locked`: after the lock, the results screens decide). Cancelling a
 * cancelled event changes nothing.
 */
export async function cancelEvent(
  db: Db,
  now: Date,
  actor: StaffActor,
  input: { eventId: string; reason: string },
  store?: DueStore,
): Promise<void> {
  const reason = staffReason(input.reason);
  const changed = await db.transaction(async (tx) => {
    const event = await lockedEvent(tx, input.eventId);
    if (event.status === "cancelled") return false;
    if (event.status !== "scheduled" || event.lockAt <= now) {
      throw new StaffError("event_locked");
    }
    await tx
      .update(events)
      .set({ status: "cancelled", updatedAt: now })
      .where(eq(events.id, event.id));
    await tx
      .update(sessions)
      .set({ status: "cancelled", updatedAt: now })
      .where(eq(sessions.eventId, event.id));
    await writeAudit(tx, now, {
      ...audit(actor, reason),
      action: "event.cancel",
      entityType: "event",
      entityId: event.id,
      before: { status: event.status },
      after: { status: "cancelled" },
    });
    return true;
  });
  if (changed) await replan(db, now, input.eventId, store);
}

// --- The screen's reads -------------------------------------------------------

export type CalendarRow = {
  id: string;
  round: number;
  name: string;
  circuit: string;
  dates: string;
  /** ISO. */
  lockAt: string;
  /** "Sat 20:00", UTC. */
  lock: string;
  lockAtSource: "default" | "admin";
  badge: EventBadge;
};

export type CalendarList = {
  season: number;
  /** Events not cancelled. */
  rounds: number;
  cancelled: number;
  /** ISO: when the season's calendar sync last finished, if it has. */
  syncedAt: string | null;
  events: CalendarRow[];
};

/** The season's events in round order, for the calendar table. */
export async function calendarList(
  db: Db,
  now: Date,
  seasonYear: number,
): Promise<CalendarList> {
  const rows = await db
    .select({
      id: events.id,
      round: events.round,
      name: events.name,
      circuit: circuits.name,
      status: events.status,
      lockAt: events.lockAt,
      lockAtSource: events.lockAtSource,
      first: min(sessions.scheduledStart),
      last: max(sessions.scheduledEnd),
    })
    .from(events)
    .innerJoin(seasons, eq(seasons.id, events.seasonId))
    .innerJoin(circuits, eq(circuits.id, events.circuitId))
    .leftJoin(sessions, eq(sessions.eventId, events.id))
    .where(eq(seasons.year, seasonYear))
    .groupBy(events.id, circuits.name)
    .orderBy(asc(events.round), asc(events.lockAt));
  const next = rows
    .filter((e) => e.status === "scheduled" && e.lockAt > now)
    .sort((a, b) => a.lockAt.getTime() - b.lockAt.getTime())[0];
  const [sync] = await db
    .select({ at: max(jobs.finishedAt) })
    .from(jobs)
    .where(
      and(
        eq(jobs.kind, "sync_calendar"),
        eq(jobs.status, "succeeded"),
        sql`${jobs.payload}->>'season' = ${String(seasonYear)}`,
      ),
    );
  return {
    season: seasonYear,
    rounds: rows.filter((e) => e.status !== "cancelled").length,
    cancelled: rows.filter((e) => e.status === "cancelled").length,
    syncedAt: sync?.at ? new Date(sync.at).toISOString() : null,
    events: rows.map((e) => ({
      id: e.id,
      round: e.round,
      name: e.name,
      circuit: e.circuit,
      dates: utcDates(
        e.first ? new Date(e.first) : null,
        e.last ? new Date(e.last) : null,
      ),
      lockAt: e.lockAt.toISOString(),
      lock: e.status === "cancelled" ? "–" : utcLock(e.lockAt),
      lockAtSource: e.lockAtSource,
      badge: eventBadge(e, now, e.id === next?.id),
    })),
  };
}

/** The season the calendar opens on: the active one, else this year. */
export async function calendarSeason(db: Db, now: Date): Promise<number> {
  const [active] = await db
    .select({ year: seasons.year })
    .from(seasons)
    .where(eq(seasons.status, "active"))
    .orderBy(desc(seasons.year))
    .limit(1);
  return active?.year ?? now.getUTCFullYear();
}

export type CalendarSession = {
  id: string;
  label: string;
  /** ISO. */
  start: string;
  end: string;
  timeSource: "provider" | "admin";
  status: string;
};

export type EventDetail = {
  event: {
    id: string;
    round: number;
    name: string;
    seasonYear: number;
    status: string;
    lockAt: string;
    lockAtSource: "default" | "admin";
    lockSessionId: string | null;
    lockPassed: boolean;
    /** Scheduled and not locked yet. */
    canCancel: boolean;
  };
  sessions: CalendarSession[];
  /** The event's and its sessions' audit rows, newest first. */
  history: AuditRow[];
};

/** One event for the editing panel. */
export async function eventDetail(
  db: Db,
  now: Date,
  eventId: string,
): Promise<EventDetail> {
  const [event] = await db
    .select({
      id: events.id,
      round: events.round,
      name: events.name,
      seasonYear: seasons.year,
      status: events.status,
      lockAt: events.lockAt,
      lockAtSource: events.lockAtSource,
      lockSessionId: events.lockSessionId,
    })
    .from(events)
    .innerJoin(seasons, eq(seasons.id, events.seasonId))
    .where(eq(events.id, eventId));
  if (!event) throw new StaffError("not_found");
  const rows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.eventId, eventId))
    .orderBy(asc(sessions.scheduledStart), asc(sessions.sequence));
  const history = await auditPage(db, {
    entityIds: [eventId, ...rows.map((s) => s.id)],
  });
  const lockPassed = event.lockAt <= now;
  return {
    event: {
      ...event,
      lockAt: event.lockAt.toISOString(),
      lockPassed,
      canCancel: event.status === "scheduled" && !lockPassed,
    },
    sessions: rows.map((s) => ({
      id: s.id,
      label: SESSION_LABELS[s.kind],
      start: s.scheduledStart.toISOString(),
      end: s.scheduledEnd.toISOString(),
      timeSource: s.timeSource,
      status: s.status,
    })),
    history: history.rows,
  };
}
