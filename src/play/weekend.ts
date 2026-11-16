/**
 * The weekend hub's read model (M6 Task 10, wave 3's "Weekend hub"): which
 * event the hub is about, its sessions and the state each is in, and which
 * of them a reader may see. It carries no score, so a hidden session only
 * says so ("Hidden"), and "Mark as watched" reveals it everywhere.
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  circuits,
  events,
  gameEvents,
  scoringRuns,
  sessions,
  type SESSION_KINDS,
  type SESSION_STATUSES,
} from "@/db/schema";
import type { Db } from "@/db/types";
import type { Viewer } from "@/identity/viewer";
import { SCORED_KINDS } from "@/results/validate";
import { revealedSessions, type Reader } from "@/spoilers/reveal";
import { currentGame } from "./current-game";

type SessionKind = (typeof SESSION_KINDS)[number];
type SessionStatus = (typeof SESSION_STATUSES)[number];

/**
 * How a session row reads (wave 3's "Session row states"). "Delayed" waits
 * for M8's calendar screen (finding 5): nothing sets it yet.
 */
export type SessionState =
  | "scheduled"
  | "tbc"
  | "live"
  | "red_flag"
  | "ended_early"
  | "cancelled"
  | "ended";

/**
 * A session's state at `now`. The stored status wins once it says something
 * happened (`suspended` is the red flag, `abandoned` ended early); a
 * `scheduled` or `live` row is read by the clock (HLD §7.2), and a start
 * that isn't confirmed is "TBC" until it comes.
 */
export function sessionState(
  s: {
    status: SessionStatus;
    startConfirmed: boolean;
    start: Date;
    end: Date;
  },
  now: Date,
): SessionState {
  switch (s.status) {
    case "cancelled":
      return "cancelled";
    case "abandoned":
      return "ended_early";
    case "suspended":
      return "red_flag";
    case "completed":
      return "ended";
    case "live":
      return "live";
    case "scheduled": {
      const at = now.getTime();
      if (at >= s.end.getTime()) return "ended";
      if (at >= s.start.getTime()) return "live";
      return s.startConfirmed ? "scheduled" : "tbc";
    }
  }
}

/** Each session kind's name on a row. */
export const SESSION_LABELS: Record<SessionKind, string> = {
  fp1: "Practice 1",
  fp2: "Practice 2",
  fp3: "Practice 3",
  sprint_qualifying: "Sprint Qualifying",
  sprint: "Sprint",
  qualifying: "Qualifying",
  race: "Race",
};

export type WeekendSession = {
  id: string;
  kind: SessionKind;
  label: string;
  start: string;
  end: string;
  state: SessionState;
  /** The session whose start locks the game ("Locks team"). */
  locksTeam: boolean;
  /** Scores and ranks from it count (qualifying, sprint, race). */
  counts: boolean;
  /** Its results are scored: there is something to hide. */
  scored: boolean;
  /** The reader may see what it gave away (DM 5.7). */
  revealed: boolean;
};

export type Weekend = {
  eventId: string;
  name: string;
  round: number;
  /** The circuit's name, under the round. */
  circuit: string;
  lockAt: string;
  lockSessionId: string | null;
  /** The circuit's IANA zone, for the hub's Track switch. */
  circuitTimeZone: string;
  sessions: WeekendSession[];
};

const AFTER_LOCK = new Set(["locked", "scored", "final"]);

/**
 * The event the hub is about: the open one; else the latest that has
 * locked, until the next opens; else the next upcoming one (before the
 * season). A cancelled event has no sequence and is skipped. Null with no
 * event to show.
 */
export async function weekendFor(
  db: Db,
  now: Date,
  input: {
    gameId: string;
    reader: Reader;
  },
): Promise<Weekend | null> {
  const calendar = await db
    .select({
      eventId: gameEvents.eventId,
      sequence: gameEvents.sequence,
      status: gameEvents.status,
    })
    .from(gameEvents)
    .where(eq(gameEvents.gameId, input.gameId))
    .orderBy(asc(gameEvents.sequence));
  const sequenced = calendar.filter(
    (e) => e.sequence !== null && e.status !== "cancelled",
  );
  const chosen =
    sequenced.find((e) => e.status === "open") ??
    [...sequenced].reverse().find((e) => AFTER_LOCK.has(e.status)) ??
    sequenced.find((e) => e.status === "upcoming");
  if (!chosen) return null;

  const [event] = await db
    .select({
      id: events.id,
      name: events.name,
      round: events.round,
      lockAt: events.lockAt,
      lockSessionId: events.lockSessionId,
      circuit: circuits.name,
      timeZone: circuits.timezone,
    })
    .from(events)
    .innerJoin(circuits, eq(circuits.id, events.circuitId))
    .where(eq(events.id, chosen.eventId));
  if (!event) return null;

  const rows = await db
    .select({
      id: sessions.id,
      kind: sessions.kind,
      status: sessions.status,
      startConfirmed: sessions.startConfirmed,
      start: sessions.scheduledStart,
      end: sessions.scheduledEnd,
    })
    .from(sessions)
    .where(eq(sessions.eventId, event.id))
    .orderBy(asc(sessions.scheduledStart), asc(sessions.sequence));
  const ids = rows.map((s) => s.id);
  const scoredRows =
    ids.length === 0
      ? []
      : await db
          .selectDistinct({ id: scoringRuns.sessionId })
          .from(scoringRuns)
          .where(
            and(
              eq(scoringRuns.gameId, input.gameId),
              eq(scoringRuns.isCurrent, true),
              inArray(scoringRuns.sessionId, ids),
            ),
          );
  const scored = new Set(scoredRows.map((r) => r.id));
  const revealed = await revealedSessions(db, now, input.reader, ids);

  return {
    eventId: event.id,
    name: event.name,
    round: event.round,
    circuit: event.circuit,
    lockAt: event.lockAt.toISOString(),
    lockSessionId: event.lockSessionId,
    circuitTimeZone: event.timeZone,
    sessions: rows.map((s) => ({
      id: s.id,
      kind: s.kind,
      label: SESSION_LABELS[s.kind],
      start: s.start.toISOString(),
      end: s.end.toISOString(),
      state: sessionState(s, now),
      locksTeam: s.id === event.lockSessionId,
      counts: SCORED_KINDS.includes(s.kind),
      scored: scored.has(s.id),
      revealed: revealed.has(s.id),
    })),
  };
}

/** A viewer's reader for the spoiler check, or null when logged out. */
export function readerOf(viewer: Viewer | null): Reader {
  return viewer
    ? {
        userId: viewer.userId,
        spoilerProtection: viewer.profile.spoilerProtection,
      }
    : null;
}

/** The hub page: the weekend, and what the screen needs to show time. */
export type WeekendPage = {
  /** Null before the season's game opens (`<NoGame />`). */
  weekend: Weekend | null;
  hasGame: boolean;
  /** The request's "now", so the countdown runs on the server's clock. */
  now: string;
  /**
   * The signed-in viewer's zone (`profiles.timezone`); null when logged out,
   * and the screen uses the browser's.
   */
  timeZone: string | null;
  signedIn: boolean;
};

/**
 * `/weekend`. A logged-out visitor's answer is the same for everyone (no
 * watched state, the 7-day window), so the page can be cached (decision 3).
 */
export async function weekendPage(
  db: Db,
  now: Date,
  viewer: Viewer | null,
): Promise<WeekendPage> {
  const game = await currentGame(db);
  const weekend = game
    ? await weekendFor(db, now, {
        gameId: game.id,
        reader: readerOf(viewer),
      })
    : null;
  return {
    weekend,
    hasGame: game !== null,
    now: now.toISOString(),
    timeZone: viewer?.profile.timezone ?? null,
    signedIn: viewer !== null,
  };
}
