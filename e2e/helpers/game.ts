import { readFileSync } from "node:fs";
import { expect, type APIRequestContext } from "@playwright/test";

// The fantasy project's helpers (playwright.config's `fantasy` project). They
// drive the local-only routes `/api/test/game` and `/api/test/clock`, which
// seed the recorded 2026 game and move the simulated clock on a replay-mode
// server. Only one spec runs at a time against it, since there is one clock.

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

type JolpicaTime = { date: string; time: string };
type JolpicaRace = JolpicaTime & {
  round: string;
  Qualifying?: JolpicaTime;
  SprintQualifying?: JolpicaTime;
};

const calendar = JSON.parse(
  readFileSync(
    new URL("../../tests/fixtures/jolpica/2026.json", import.meta.url),
    "utf8",
  ),
) as { MRData: { RaceTable: { Races: JolpicaRace[] } } };

const startOf = (at: JolpicaTime) => Date.parse(`${at.date}T${at.time}`);
const iso = (ms: number) =>
  new Date(Math.ceil(ms / MINUTE_MS) * MINUTE_MS).toISOString();

/**
 * The instants a spec moves a recorded round to, from the recorded calendar.
 * The lock is the first qualifying session's start (sprint qualifying on a
 * sprint weekend). Results appear 30 minutes after a session's scheduled
 * end, and the event is final 48 hours after the race's, so each instant
 * leaves room for the polls and the scoring after it.
 */
function roundTimes(round: number) {
  const race = calendar.MRData.RaceTable.Races.find(
    (r) => Number(r.round) === round,
  );
  const qualifying = race?.SprintQualifying ?? race?.Qualifying;
  if (!race || !qualifying) throw new Error(`no round ${round} in 2026.json`);
  const lock = startOf(qualifying);
  const raceStart = startOf(race);
  return {
    /** Its lock: the start of qualifying. */
    lock: iso(lock),
    /** An hour before the lock: the round is open. */
    beforeLock: iso(lock - HOUR_MS),
    /** A minute after the lock: the round is locked, nothing is scored. */
    afterLock: iso(lock + MINUTE_MS),
    /** Qualifying has results, and they are scored. */
    afterQualifying: iso(startOf(race.Qualifying ?? qualifying) + 3 * HOUR_MS),
    /** The race has results, and they are scored. */
    afterRace: iso(raceStart + 4 * HOUR_MS),
    /** Past the +48 hour finalize after the race's end: the event is final. */
    final: iso(raceStart + 51 * HOUR_MS),
  };
}

export const ROUND_1 = roundTimes(1);

/** What `GET /api/test/game` reports of the seeded game. */
export type GameState = {
  gameId: string | null;
  now: string;
  status: string | null;
  priceUpdates: number;
  rounds: Array<{
    round: number;
    status: string;
    pool: number;
    prices: number;
    scoredSessions: number;
  }>;
};

// Seeding imports the season; moving the clock runs every job on the way.
const SLOW = { timeout: 120_000 };

/**
 * Resets the local database, sets the simulated clock to `at` and seeds the
 * 2026 game over the recorded fixtures with our own starting prices.
 */
export async function seedGame(
  request: APIRequestContext,
  at: string,
): Promise<{ gameId: string }> {
  const response = await request.post("/api/test/game", {
    data: { at },
    ...SLOW,
  });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as { gameId: string };
}

/**
 * Moves the simulated clock to `to`, running every job due on the way (lock,
 * polls, scoring, finalize, prices) on the recorded results.
 */
export async function moveClock(
  request: APIRequestContext,
  to: string,
): Promise<{ now: string; jobsRun: number }> {
  const response = await request.post("/api/test/clock", {
    data: { to },
    ...SLOW,
  });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as { now: string; jobsRun: number };
}

/** The seeded game's status and each round's, for the harness's own checks. */
export async function gameState(
  request: APIRequestContext,
): Promise<GameState> {
  const response = await request.get("/api/test/game");
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as GameState;
}

/** One round of `gameState`. */
export function roundOf(state: GameState, round: number) {
  const found = state.rounds.find((r) => r.round === round);
  if (!found) throw new Error(`the game has no round ${round}`);
  return found;
}
