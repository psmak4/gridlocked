/**
 * The 2026 game over the recorded reference data, as the tests and the local
 * e2e server seed it: the calendar, roster, seats and entries imported from
 * the fixtures, the game created with the 2026 rules, its pool seeded from
 * round 1, and our own starting prices (`prices-2026.json`, never the
 * official game's) published for that event as `initial`.
 *
 * It lives with the replay because it reads `provider_ids` to find each
 * asset's price by its Jolpica key, which only the adapters may do.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { events, poolAssets, providerIds } from "@/db/schema";
import type { Db } from "@/db/types";
import { createGame } from "@/game/games";
import { seedPool } from "@/game/pool";
import { publishPrices } from "@/game/prices";
import { RULESET_2026 } from "@/game/ruleset";
import { fixedClock } from "@/lib/clock";
import { SCORING_RULES_2026 } from "@/scoring/rules";
import { importReference2026 } from "../import/import-season";

const pricesSchema = z.object({
  drivers: z.record(z.string(), z.number().int()),
  constructors: z.record(z.string(), z.number().int()),
});

export type Prices2026 = z.infer<typeof pricesSchema>;

/** The starting prices in `<fixturesDir>/prices-2026.json`, by Jolpica key. */
export function readPrices2026(fixturesDir: string): Prices2026 {
  return pricesSchema.parse(
    JSON.parse(readFileSync(join(fixturesDir, "prices-2026.json"), "utf8")),
  );
}

/**
 * Seeds the game into `db` (migrated, with no 2026 data yet) as of `now`.
 * `assetId` finds a pool asset by the Jolpica key of its driver or
 * constructor.
 */
export async function seedGame2026(
  db: Db,
  now: Date,
  fixturesDir: string,
): Promise<{
  gameId: string;
  assetId: (jolpicaKey: string) => Promise<string>;
}> {
  const { seasonId } = await importReference2026(
    db,
    fixedClock(now),
    fixturesDir,
  );
  const { gameId } = await createGame(db, now, {
    seasonId,
    slug: "2026-fantasy",
    name: "2026 Fantasy",
    params: RULESET_2026,
    rules: SCORING_RULES_2026,
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
  const starting = readPrices2026(fixturesDir);
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
