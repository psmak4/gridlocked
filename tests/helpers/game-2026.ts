// Test helper for the game layer: the 2026 game over the recorded reference
// data. Like the other helpers it may import src/providers (and read
// `provider_ids`, which src/game must not).
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { events, gameEvents } from "@/db/schema";
import type { Db } from "@/db/types";
import type { ClockDb } from "@/lib/resolve-clock";
import { lockEvent } from "@/game/lock";
import { carryPrices } from "@/game/prices";
import {
  readPrices2026,
  seedGame2026 as seedFromFixtures,
} from "@/providers/replay/seed-2026";
import { setSimulatedClock } from "@/replay/clock-loop";

const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));

/** The starting prices of tests/fixtures/prices-2026.json, by Jolpica key. */
export function loadPrices2026() {
  return readPrices2026(FIXTURES);
}

/**
 * Imports the 2026 reference data, creates the game, seeds its pool from round
 * 1 and publishes the fixture's starting prices for that event as `initial`
 * (`src/providers/replay/seed-2026.ts`, which the local e2e server seeds
 * with too). `assetId` finds a pool asset by the Jolpica key of its driver or
 * constructor.
 */
export async function seedGame2026(db: Db, now: Date) {
  return seedFromFixtures(db, now, FIXTURES);
}

/** Round `n` of the 2026 season: its event id and lock. */
export async function round2026(db: Db, n: number) {
  const [row] = await db
    .select({ id: events.id, lockAt: events.lockAt })
    .from(events)
    .where(eq(events.round, n));
  if (!row) throw new Error(`no round ${n}`);
  return row;
}

/**
 * Locks an event as the lock job does: both clocks move to its `lock_at`, and
 * `lockEvent` runs until it is done. Returns the lock time.
 */
export async function lockRound(
  db: Db & ClockDb,
  gameId: string,
  eventId: string,
) {
  const [event] = await db
    .select({ lockAt: events.lockAt })
    .from(events)
    .where(eq(events.id, eventId));
  if (!event) throw new Error(`no event ${eventId}`);
  const { lockAt } = event;
  await setSimulatedClock(db, lockAt);
  let afterTeamId: string | undefined;
  for (;;) {
    const batch = await lockEvent(db, lockAt, { gameId, eventId, afterTeamId });
    if (batch.done) return lockAt;
    afterTeamId = batch.lastTeamId ?? undefined;
  }
}

/**
 * Opens an event as the open job does (`createGameHandlers`' `game_open`), in
 * one transaction: prices carried for every asset with none, even after a full
 * list was published, then the event goes from `upcoming` to `open`. The
 * clock is left where it is.
 */
export async function openRound(
  db: Db,
  now: Date,
  gameId: string,
  eventId: string,
) {
  await db.transaction(async (tx) => {
    await carryPrices(tx, now, { gameId, eventId });
    await tx
      .update(gameEvents)
      .set({ status: "open", updatedAt: now })
      .where(
        and(
          eq(gameEvents.gameId, gameId),
          eq(gameEvents.eventId, eventId),
          eq(gameEvents.status, "upcoming"),
        ),
      );
  });
}
