// Test helper for the game layer: the 2026 game over the recorded reference
// data. Like the other helpers it may import src/providers (and read
// `provider_ids`, which src/game must not).
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { events, gameEvents, poolAssets, providerIds } from "@/db/schema";
import type { Db } from "@/db/types";
import type { ClockDb } from "@/lib/resolve-clock";
import { createGame } from "@/game/games";
import { lockEvent } from "@/game/lock";
import { seedPool } from "@/game/pool";
import { carryPrices, publishPrices } from "@/game/prices";
import { RULESET_2026 } from "@/game/ruleset";
import { setSimulatedClock } from "@/replay/clock-loop";
import { readFixture } from "./fixtures";
import { importReferenceFixtures2026 } from "./pipeline-2026";

const pricesSchema = z.object({
  drivers: z.record(z.string(), z.number().int()),
  constructors: z.record(z.string(), z.number().int()),
});

/** The starting prices of tests/fixtures/prices-2026.json, by Jolpica key. */
export function loadPrices2026() {
  return pricesSchema.parse(readFixture("prices-2026.json"));
}

/**
 * Imports the 2026 reference data, creates the game, seeds its pool from round
 * 1 and publishes the fixture's starting prices for that event as `initial`.
 * `assetId` finds a pool asset by the Jolpica key of its driver or constructor.
 */
export async function seedGame2026(db: Db, now: Date) {
  const { seasonId } = await importReferenceFixtures2026(db, now);
  const { gameId } = await createGame(db, now, {
    seasonId,
    slug: "2026-fantasy",
    name: "2026 Fantasy",
    params: RULESET_2026,
    notes: "The 2026 rules.",
  });
  const [round1] = await db
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.seasonId, seasonId), eq(events.round, 1)));
  await seedPool(db, now, { gameId, fromEventId: round1!.id });

  const keys = new Map(
    (
      await db
        .select()
        .from(providerIds)
        .where(eq(providerIds.provider, "jolpica"))
    ).map((row) => [row.entityId, row.providerKey]),
  );
  const pool = await db
    .select()
    .from(poolAssets)
    .where(eq(poolAssets.gameId, gameId));
  const starting = loadPrices2026();
  await publishPrices(db, now, {
    gameId,
    eventId: round1!.id,
    source: "initial",
    prices: pool.map((asset) => {
      const key = keys.get((asset.driverId ?? asset.constructorId)!);
      const price =
        asset.assetType === "driver"
          ? starting.drivers[key!]
          : starting.constructors[key!];
      if (price === undefined) {
        throw new Error(`prices-2026.json has no price for ${key}`);
      }
      return { assetId: asset.id, price };
    }),
  });

  const assetId = async (jolpicaKey: string): Promise<string> => {
    const entityIds = new Set(
      [...keys].filter(([, key]) => key === jolpicaKey).map(([id]) => id),
    );
    const found = (
      await db.select().from(poolAssets).where(eq(poolAssets.gameId, gameId))
    ).filter((a) => entityIds.has((a.driverId ?? a.constructorId)!));
    if (found.length !== 1) {
      throw new Error(`${jolpicaKey}: ${found.length} pool assets, expected 1`);
    }
    return found[0]!.id;
  };
  return { gameId, assetId };
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
 * Opens an event as the open job does (Task 6): prices carried where it has
 * none, then the event is `open`. The clock is left where it is.
 */
export async function openRound(
  db: Db,
  now: Date,
  gameId: string,
  eventId: string,
) {
  await carryPrices(db, now, { gameId, eventId });
  await db
    .update(gameEvents)
    .set({ status: "open", updatedAt: now })
    .where(and(eq(gameEvents.gameId, gameId), eq(gameEvents.eventId, eventId)));
}
