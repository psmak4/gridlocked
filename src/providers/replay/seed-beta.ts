/**
 * Makes an empty, migrated database the closed beta's (M9 Task 13): the 2026
 * game from round 1 (`seedGame2026`: reference data, game, our starting
 * prices, no results), opened, with its jobs planned and the replay's clock
 * running. Results arrive as the replay's own polls reach them.
 *
 * The clock is real time minus a whole number of days, chosen so round 1's
 * Friday lands on the first beta Friday: sessions keep their times of day,
 * and testers sign up and pick teams in the days before.
 *
 * All in one transaction, so a failed run leaves the database empty and can
 * be run again. It refuses any database that isn't empty, so it can never
 * write to staging's `main`. Run by `scripts/seed-beta.ts`.
 */
import { eq, ne, sql } from "drizzle-orm";
import {
  events,
  gameEvents,
  games,
  providerRequests,
  seasons,
  users,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { planGameJobs } from "@/game/jobs";
import { openGame } from "@/game/lineups";
import { SYSTEM_USER_ID } from "@/identity/system";
import { planEventJobs } from "@/jobs/plan-event";
import { ensureCalendarSync } from "@/jobs/sync-calendar";
import { simulatedClockAt, type ClockDb } from "@/lib/resolve-clock";
import { setSimulatedClock } from "@/replay/clock-loop";
import { setSetting } from "@/settings/write";
import type { StaffActor } from "@/staff/roster";
import { seedGame2026 } from "./seed-2026";

/** Round 1's first day in the recorded calendar (UTC). */
export const ROUND_1_FRIDAY = "2026-03-06";
/** The draft legal documents are dated here (migration 0053). */
const DOCUMENTS_FROM = "2026-01-01";
const DAY_MS = 86_400_000;
const FRIDAY = 5;

const midnight = (day: string) => Date.parse(`${day}T00:00:00Z`);

/**
 * The replay's offset: how long after round 1's Friday the first beta Friday
 * is. Refused: a date that isn't a Friday at least a day ahead, or one so far
 * ahead that the replay would start before 2026.
 */
export function betaOffsetSeconds(realNow: Date, firstFriday: string): number {
  const friday = midnight(firstFriday);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(firstFriday) ||
    Number.isNaN(friday) ||
    new Date(friday).toISOString().slice(0, 10) !== firstFriday
  ) {
    throw new Error(`first Friday: expected a date as yyyy-mm-dd`);
  }
  if (new Date(friday).getUTCDay() !== FRIDAY) {
    throw new Error(`first Friday: ${firstFriday} is not a Friday`);
  }
  if (friday < realNow.getTime() + DAY_MS) {
    throw new Error(
      `first Friday: ${firstFriday} must be at least a day from now, so testers can pick a team`,
    );
  }
  const offsetMs = friday - midnight(ROUND_1_FRIDAY);
  if (realNow.getTime() - offsetMs < midnight(DOCUMENTS_FROM)) {
    throw new Error(
      `first Friday: ${firstFriday} is too far ahead: the replay would start before ${DOCUMENTS_FROM}`,
    );
  }
  return offsetMs / 1000;
}

async function requireEmpty(db: Db & ClockDb): Promise<void> {
  const used: string[] = [];
  if ((await simulatedClockAt(db)) !== null) used.push("a replay clock");
  const [season] = await db.select({ id: seasons.id }).from(seasons).limit(1);
  if (season) used.push("seasons");
  const [game] = await db.select({ id: games.id }).from(games).limit(1);
  if (game) used.push("games");
  const [polled] = await db
    .select({ one: sql`1` })
    .from(providerRequests)
    .limit(1);
  if (polled) used.push("provider_requests");
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(ne(users.id, SYSTEM_USER_ID))
    .limit(1);
  if (user) used.push("users");
  if (used.length > 0) {
    throw new Error(
      `this database is not empty (${used.join(", ")}): the beta is seeded into a fresh one`,
    );
  }
}

export async function seedBeta(
  db: Db & ClockDb,
  realNow: Date,
  input: { firstFriday: string; fixturesDir: string; actor: StaffActor },
): Promise<{ gameId: string; at: Date; offsetSeconds: number }> {
  const offsetSeconds = betaOffsetSeconds(realNow, input.firstFriday);
  const at = new Date(realNow.getTime() - offsetSeconds * 1000);
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db & ClockDb;
    await requireEmpty(t);
    await setSimulatedClock(t, at);
    const { gameId } = await seedGame2026(t, at, input.fixturesDir);
    await openGame(t, at, gameId);
    await planGameJobs(t, at, gameId);
    const calendar = await t
      .select({ eventId: gameEvents.eventId })
      .from(gameEvents)
      .innerJoin(events, eq(events.id, gameEvents.eventId))
      .where(eq(gameEvents.gameId, gameId))
      .orderBy(events.round);
    for (const { eventId } of calendar) await planEventJobs(t, eventId);
    await ensureCalendarSync(t, at);
    await setSetting(t, at, input.actor, {
      key: "replay_offset",
      value: { mode: "running", seconds: offsetSeconds },
      reason: "The closed beta is seeded",
    });
    return { gameId, at, offsetSeconds };
  });
}
