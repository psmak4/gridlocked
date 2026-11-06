import { and, asc, desc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import {
  assetPrices,
  assetScoreLines,
  assetSessionTotals,
  gameEvents,
  poolAssets,
  priceUpdateRuns,
  rulesetVersions,
  scoringRuns,
  sessions,
  type POOL_ASSET_TYPES,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { newId } from "@/lib/ids";
import type { MoneyUnits } from "@/lib/money";
import { loadGameEvent, publishPrices } from "./prices";
import { rulesetParamsSchema, type RulesetParams } from "./ruleset";

// The price formula (DM 3.5): after an event is scored, each asset's price for
// the next event moves with how its last few events compare with what its
// price should earn. `priceChange` is the pure step; `runPriceUpdate` reads
// the scores, writes the next event's `formula` prices and records why.

type PoolAssetType = (typeof POOL_ASSET_TYPES)[number];
export type PriceFormula = RulesetParams["prices"]["formula"];
export type PriceTier = "terrible" | "poor" | "good" | "great";

/** In the order of a formula's `changes` lists. */
const TIERS: readonly PriceTier[] = ["terrible", "poor", "good", "great"];

/**
 * The average of the newest `window` events' points, or null when there are
 * none. `recentPoints` runs oldest first, so the newest are the last.
 */
export function recentAverage(
  recentPoints: number[],
  window: number,
): number | null {
  const used = recentPoints.slice(-window);
  if (used.length === 0) return null;
  return used.reduce((sum, p) => sum + p, 0) / used.length;
}

/**
 * The average, with the points this game doesn't score, over the points the
 * price should earn: its price in $M times the asset type's points per million.
 */
export function priceRatio(input: {
  price: MoneyUnits;
  assetType: PoolAssetType;
  average: number;
  formula: PriceFormula;
}): number {
  const { price, assetType, average, formula } = input;
  return (
    (average + formula.unscoredPoints[assetType]) /
    ((price / 10) * formula.pointsPerMillion[assetType])
  );
}

/**
 * The formula for one asset: its tier, the change in $0.1M that tier means in
 * its price band, and the new price, clamped to the version's bounds. `change`
 * is the tier's change before the clamp. `recentPoints` is the asset's points
 * in its recent events, oldest first; only the newest `formula.window` count,
 * and with none the price stands and the tier is null.
 */
export function priceChange(input: {
  price: MoneyUnits;
  assetType: PoolAssetType;
  recentPoints: number[];
  formula: PriceFormula;
  /** The version's `prices.min` and `prices.max`. */
  bounds: { min: MoneyUnits; max: MoneyUnits };
}): { tier: PriceTier | null; change: number; newPrice: MoneyUnits } {
  const { price, formula } = input;
  const average = recentAverage(input.recentPoints, formula.window);
  if (average === null) return { tier: null, change: 0, newPrice: price };

  const ratio = priceRatio({ ...input, average });
  const { poor, good, great } = formula.thresholds;
  const index = ratio < poor ? 0 : ratio < good ? 1 : ratio < great ? 2 : 3;
  const band = price >= formula.bandSplit ? "expensive" : "cheap";
  const change = formula.changes[band][index]!;
  return {
    tier: TIERS[index]!,
    change,
    newPrice: Math.min(
      input.bounds.max,
      Math.max(input.bounds.min, price + change),
    ),
  };
}

/** What `price_update_runs.inputs` says about one asset's change. */
interface AssetInput {
  assetId: string;
  assetType: PoolAssetType;
  /** The price in force for the scored event. */
  price: MoneyUnits;
  /** Its points in the recent scored events since it joined, oldest first. */
  recentPoints: number[];
  average: number | null;
  ratio: number | null;
  tier: PriceTier | null;
  change: number;
  newPrice: MoneyUnits;
  /** Set when the next event already has this asset's price from staff: it stays. */
  kept?: "admin";
  /** Set when it missed the scored event: its price stands. */
  absent?: true;
}

/**
 * Prices the next event from the scores of `afterEventId`, as `formula`, and
 * records the run. The next event is the game's next non-cancelled one by
 * sequence, priced by the ruleset version in force for it. Every asset with a
 * price for `afterEventId` is priced, withdrawn ones included, since owners
 * keep them; an asset with none (one added since) keeps any price it already
 * has for the next event, as does one whose price for the next event is
 * already an `admin` one (recorded in `inputs` as `kept`). An asset with no lines in a scored event scored 0
 * there, and the events before it joined aren't in its window: an asset's
 * events start at its `added_from_event_id`, placed by sequence as the lineup
 * check places it. Then `publishPrices` completes the list. Running it again
 * replaces the rows with a new run.
 *
 * Skips, writing nothing, when `afterEventId` has no scored session (a
 * current run on any of its sessions), when no later event is left and when
 * the next event is no longer `upcoming`: its prices are fixed from the
 * moment its window opens (DM 3.5).
 */
export async function runPriceUpdate(
  db: Db,
  now: Date,
  input: { gameId: string; afterEventId: string; ranBy: string },
): Promise<
  { runId: string } | { skipped: "next_open" | "no_scores" | "no_next" }
> {
  const { gameId, afterEventId, ranBy } = input;
  return db.transaction(async (tx) => {
    const after = await loadGameEvent(tx, gameId, afterEventId);
    // A cancelled event is never scored.
    if (after.sequence === null) return { skipped: "no_scores" } as const;

    // The next event, held so the open job waits for this update to finish.
    const [next] = await tx
      .select()
      .from(gameEvents)
      .where(
        and(
          eq(gameEvents.gameId, gameId),
          isNotNull(gameEvents.sequence),
          sql`${gameEvents.sequence} > ${after.sequence}`,
        ),
      )
      .orderBy(asc(gameEvents.sequence))
      .limit(1)
      .for("update");

    // The formula of the version in force for the event being priced.
    const [version] = await tx
      .select({ params: rulesetVersions.params })
      .from(rulesetVersions)
      .where(eq(rulesetVersions.id, (next ?? after).rulesetVersionId));
    if (!version) throw new Error("price update: the event has no ruleset");
    const { formula, min, max } = rulesetParamsSchema.parse(
      version.params,
    ).prices;

    // Scored events up to this one, newest first: those with a session whose
    // lines are a current run's. All of them, since an asset's last few skip
    // the events it missed.
    const scoredNewestFirst = await tx
      .selectDistinct({
        eventId: gameEvents.eventId,
        sequence: gameEvents.sequence,
      })
      .from(gameEvents)
      .innerJoin(sessions, eq(sessions.eventId, gameEvents.eventId))
      .innerJoin(
        scoringRuns,
        and(
          eq(scoringRuns.sessionId, sessions.id),
          eq(scoringRuns.gameId, gameEvents.gameId),
          eq(scoringRuns.isCurrent, true),
        ),
      )
      .where(
        and(
          eq(gameEvents.gameId, gameId),
          isNotNull(gameEvents.sequence),
          lte(gameEvents.sequence, after.sequence),
        ),
      )
      .orderBy(desc(gameEvents.sequence));
    if (!scoredNewestFirst.some((e) => e.eventId === afterEventId)) {
      return { skipped: "no_scores" } as const;
    }
    if (!next) return { skipped: "no_next" } as const;
    if (next.status !== "upcoming") return { skipped: "next_open" } as const;

    // Each asset's points per scored event: the sum of its session totals.
    const scoredOldestFirst = [...scoredNewestFirst].reverse();
    const eventIds = scoredOldestFirst.map((e) => e.eventId);
    const totals = new Map<string, number>();
    for (const row of await tx
      .select({
        eventId: sessions.eventId,
        assetId: assetSessionTotals.assetId,
        points: sql<number>`sum(${assetSessionTotals.points})::integer`,
      })
      .from(assetSessionTotals)
      .innerJoin(sessions, eq(sessions.id, assetSessionTotals.sessionId))
      .where(
        and(
          eq(assetSessionTotals.gameId, gameId),
          inArray(sessions.eventId, eventIds),
        ),
      )
      .groupBy(sessions.eventId, assetSessionTotals.assetId)) {
      totals.set(`${row.eventId}/${row.assetId}`, row.points);
    }
    // Asset by event where every line is an `absent` penalty.
    const missed = new Set(
      (
        await tx
          .select({
            eventId: sessions.eventId,
            assetId: assetScoreLines.assetId,
          })
          .from(assetScoreLines)
          .innerJoin(sessions, eq(sessions.id, assetScoreLines.sessionId))
          .where(
            and(
              eq(assetScoreLines.gameId, gameId),
              inArray(sessions.eventId, eventIds),
            ),
          )
          .groupBy(sessions.eventId, assetScoreLines.assetId)
          .having(
            sql`bool_and(${assetScoreLines.detail}->>'reason' is not distinct from 'absent')`,
          )
      ).map((row) => `${row.eventId}/${row.assetId}`),
    );

    const priced = await tx
      .select({
        assetId: assetPrices.assetId,
        assetType: poolAssets.assetType,
        price: assetPrices.price,
        // Null for an event past the last one: then none of them count.
        joinedAt: sql<
          number | null
        >`game_event_sequence_from(${poolAssets.gameId}, ${poolAssets.addedFromEventId})`,
      })
      .from(assetPrices)
      .innerJoin(poolAssets, eq(poolAssets.id, assetPrices.assetId))
      .where(
        and(
          eq(poolAssets.gameId, gameId),
          eq(assetPrices.eventId, afterEventId),
        ),
      )
      .orderBy(asc(assetPrices.assetId));
    // A price staff set for the next event stays (DM 3.5).
    const admin = new Map(
      (
        await tx
          .select({ assetId: assetPrices.assetId, price: assetPrices.price })
          .from(assetPrices)
          .where(
            and(
              eq(assetPrices.eventId, next.eventId),
              eq(assetPrices.source, "admin"),
            ),
          )
      ).map((row) => [row.assetId, row.price]),
    );
    const assets: AssetInput[] = priced.map(
      ({ assetId, assetType, price, joinedAt }) => {
        const absent = missed.has(`${afterEventId}/${assetId}`);
        const recentPoints = absent
          ? []
          : scoredOldestFirst
              .filter(
                ({ eventId, sequence }) =>
                  joinedAt !== null &&
                  sequence! >= joinedAt &&
                  !missed.has(`${eventId}/${assetId}`),
              )
              .map(({ eventId }) => totals.get(`${eventId}/${assetId}`) ?? 0)
              .slice(-formula.window);
        const average = recentAverage(recentPoints, formula.window);
        const kept = admin.get(assetId);
        return {
          assetId,
          assetType,
          price,
          recentPoints,
          average,
          ratio:
            average === null
              ? null
              : priceRatio({ price, assetType, average, formula }),
          ...priceChange({
            price,
            assetType,
            recentPoints,
            formula,
            bounds: { min, max },
          }),
          ...(absent ? { absent: true as const } : {}),
          ...(kept === undefined
            ? {}
            : { kept: "admin" as const, change: 0, newPrice: kept }),
        };
      },
    );

    const runId = newId();
    await tx.insert(priceUpdateRuns).values({
      id: runId,
      gameId,
      afterEventId,
      rulesetVersionId: next.rulesetVersionId,
      inputs: { eventId: next.eventId, assets },
      ranAt: now,
      ranBy,
    });
    await publishPrices(tx, now, {
      gameId,
      eventId: next.eventId,
      source: "formula",
      runId,
      prices: assets
        .filter((a) => a.kept === undefined)
        .map((a) => ({ assetId: a.assetId, price: a.newPrice })),
    });
    return { runId };
  });
}
