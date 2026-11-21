/**
 * The prices screen (M8 Task 9, wave 5's price update board). Prices publish
 * themselves (decision 1): `finalizeGameEvent` runs `runPriceUpdate`, which
 * writes and publishes the next event's list. This shows that list with each
 * asset's inputs from the run (`price_update_runs.inputs`), and
 * **Change one by hand** sets an `admin` price, with a reason, while the event
 * is still `upcoming`. The formula keeps an admin price (DM 3.5).
 */
import { and, asc, desc, eq, isNotNull, sql } from "drizzle-orm";
import { z } from "zod";
import {
  assetPrices,
  constructors,
  drivers,
  events,
  gameEvents,
  poolAssets,
  priceUpdateRuns,
  PRICE_MAX,
  PRICE_MIN,
  rulesetVersions,
  type PRICE_SOURCES,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { priceRatio, recentAverage } from "@/game/price-formula";
import { publishPrices } from "@/game/prices";
import { rulesetParamsSchema, type RulesetParams } from "@/game/ruleset";
import { StaffError } from "./errors";
import { requireReason, type StaffActor } from "./roster";

type PriceSource = (typeof PRICE_SOURCES)[number];
type Thresholds = RulesetParams["prices"]["formula"]["thresholds"];

/** The board's words for how an asset did against what its price expects. */
export const PRICE_WORDS = [
  "Much better",
  "Better",
  "A bit better",
  "As expected",
  "A bit worse",
  "Worse",
  "Much worse",
] as const;
export type PriceWord = (typeof PRICE_WORDS)[number];

/**
 * How an asset did, from its ratio (`priceRatio`), in the board's seven words.
 * The words follow the formula's tiers, so the direction always matches the
 * price change: below `poor` is Much worse; the poor tier splits at its middle
 * into Worse and A bit worse; the good tier into As expected and A bit better;
 * and the great tier is Better up to `great` plus the good tier's width, then
 * Much better. Null with no recent races.
 */
export function howItDid(
  ratio: number | null,
  thresholds: Thresholds,
): PriceWord | null {
  if (ratio === null) return null;
  const { poor, good, great } = thresholds;
  if (ratio < poor) return "Much worse";
  if (ratio < (poor + good) / 2) return "Worse";
  if (ratio < good) return "A bit worse";
  if (ratio < (good + great) / 2) return "As expected";
  if (ratio < great) return "A bit better";
  if (ratio < great + (great - good)) return "Better";
  return "Much better";
}

export type PriceRow = {
  assetId: string;
  name: string;
  kind: "driver" | "constructor";
  /** The price in force now, in units of $0.1M. */
  now: number | null;
  /** Its average over the formula's window, or null with no recent races. */
  average: number | null;
  /** The points its price expects, with the ones this game doesn't score. */
  expects: number | null;
  word: PriceWord | null;
  /** Why there's no word, or why the formula didn't set its price. */
  note: "Set by staff" | "Missed the race" | "No recent races" | null;
  change: number | null;
  /** Its price for the next event, once there is one. */
  next: number | null;
  source: PriceSource | null;
};

export type NextPrices = {
  event: { id: string; round: number; name: string };
  /** The event before it, whose prices carry over if no update runs. */
  previous: { id: string; round: number; name: string } | null;
  /** Builders see the list (`prices_ready_at`). */
  published: boolean;
  /** The event whose scores the update read: "Published when … became final". */
  publishedAfter: { id: string; round: number; name: string } | null;
  rows: PriceRow[];
  counts: { up: number; down: number; same: number; staff: number };
};

const runInputsSchema = z.object({
  eventId: z.string(),
  assets: z.array(
    z.object({
      assetId: z.string(),
      price: z.number(),
      recentPoints: z.array(z.number()),
      average: z.number().nullable(),
      ratio: z.number().nullable(),
      kept: z.literal("admin").optional(),
      absent: z.literal(true).optional(),
    }),
  ),
});

/** The game's next `upcoming` event, by sequence, or null when none is left. */
async function upcomingEvent(db: Db, gameId: string) {
  const [row] = await db
    .select({
      id: gameEvents.eventId,
      round: events.round,
      name: events.name,
      sequence: gameEvents.sequence,
      pricesReadyAt: gameEvents.pricesReadyAt,
      rulesetVersionId: gameEvents.rulesetVersionId,
    })
    .from(gameEvents)
    .innerJoin(events, eq(events.id, gameEvents.eventId))
    .where(
      and(
        eq(gameEvents.gameId, gameId),
        eq(gameEvents.status, "upcoming"),
        isNotNull(gameEvents.sequence),
      ),
    )
    .orderBy(asc(gameEvents.sequence))
    .limit(1);
  return row ?? null;
}

/** An event's round and name. */
async function eventLabel(db: Db, eventId: string) {
  const [row] = await db
    .select({ id: events.id, round: events.round, name: events.name })
    .from(events)
    .where(eq(events.id, eventId));
  return row ?? null;
}

/**
 * The next event's price list with each asset's inputs, or null when the game
 * has no upcoming event left. Before its update runs, the rows are the
 * previous event's prices, with nothing next.
 */
export async function nextPrices(
  db: Db,
  gameId: string,
): Promise<NextPrices | null> {
  const event = await upcomingEvent(db, gameId);
  if (!event) return null;

  const [previousRow] = await db
    .select({ id: gameEvents.eventId })
    .from(gameEvents)
    .where(
      and(
        eq(gameEvents.gameId, gameId),
        isNotNull(gameEvents.sequence),
        sql`${gameEvents.sequence} < ${event.sequence}`,
      ),
    )
    .orderBy(desc(gameEvents.sequence))
    .limit(1);
  const previous = previousRow ? await eventLabel(db, previousRow.id) : null;

  const [run] = await db
    .select({
      afterEventId: priceUpdateRuns.afterEventId,
      inputs: priceUpdateRuns.inputs,
    })
    .from(priceUpdateRuns)
    .where(
      and(
        eq(priceUpdateRuns.gameId, gameId),
        sql`${priceUpdateRuns.inputs}->>'eventId' = ${event.id}`,
      ),
    )
    .orderBy(desc(priceUpdateRuns.ranAt), desc(priceUpdateRuns.id))
    .limit(1);
  const inputs = new Map(
    (run ? runInputsSchema.parse(run.inputs).assets : []).map((a) => [
      a.assetId,
      a,
    ]),
  );

  const [version] = await db
    .select({ params: rulesetVersions.params })
    .from(rulesetVersions)
    .where(eq(rulesetVersions.id, event.rulesetVersionId));
  const { formula } = rulesetParamsSchema.parse(version!.params).prices;

  const pricesFor = async (eventId: string) =>
    new Map(
      (
        await db
          .select({
            assetId: assetPrices.assetId,
            price: assetPrices.price,
            source: assetPrices.source,
          })
          .from(assetPrices)
          .where(eq(assetPrices.eventId, eventId))
      ).map((row) => [row.assetId, row]),
    );
  const next = await pricesFor(event.id);
  const before = previous ? await pricesFor(previous.id) : new Map();

  const assets = await db
    .select({
      id: poolAssets.id,
      kind: poolAssets.assetType,
      givenName: drivers.givenName,
      familyName: drivers.familyName,
      displayName: drivers.displayName,
      constructorName: constructors.name,
    })
    .from(poolAssets)
    .leftJoin(drivers, eq(drivers.id, poolAssets.driverId))
    .leftJoin(constructors, eq(constructors.id, poolAssets.constructorId))
    .where(eq(poolAssets.gameId, gameId));

  const rows: PriceRow[] = [];
  for (const asset of assets) {
    const input = inputs.get(asset.id);
    const nextRow = next.get(asset.id);
    const now = input?.price ?? before.get(asset.id)?.price ?? null;
    if (now === null && !nextRow) continue;
    const average =
      input?.average ??
      (input ? recentAverage(input.recentPoints, formula.window) : null);
    const ratio =
      input?.ratio ??
      (average !== null && now !== null
        ? priceRatio({ price: now, assetType: asset.kind, average, formula })
        : null);
    const source = nextRow?.source ?? null;
    rows.push({
      assetId: asset.id,
      name:
        asset.kind === "driver"
          ? (asset.displayName ??
            `${asset.givenName ?? ""} ${asset.familyName ?? ""}`.trim())
          : (asset.constructorName ?? ""),
      kind: asset.kind,
      now,
      average,
      expects:
        now === null
          ? null
          : Math.round(
              ((now / 10) * formula.pointsPerMillion[asset.kind] -
                formula.unscoredPoints[asset.kind]) *
                10,
            ) / 10,
      word: howItDid(ratio, formula.thresholds),
      note:
        source === "admin"
          ? "Set by staff"
          : input?.absent
            ? "Missed the race"
            : input && average === null
              ? "No recent races"
              : null,
      change: nextRow && now !== null ? nextRow.price - now : null,
      next: nextRow?.price ?? null,
      source,
    });
  }
  rows.sort(
    (a, b) =>
      (a.kind === b.kind ? 0 : a.kind === "driver" ? -1 : 1) ||
      (b.next ?? b.now ?? 0) - (a.next ?? a.now ?? 0) ||
      a.name.localeCompare(b.name),
  );

  const counts = { up: 0, down: 0, same: 0, staff: 0 };
  for (const row of rows) {
    if (row.source === "admin") counts.staff += 1;
    if (row.change === null || row.change === 0) counts.same += 1;
    else if (row.change > 0) counts.up += 1;
    else counts.down += 1;
  }

  return {
    event: { id: event.id, round: event.round, name: event.name },
    previous,
    published: event.pricesReadyAt !== null,
    publishedAfter:
      run && event.pricesReadyAt !== null
        ? await eventLabel(db, run.afterEventId)
        : null,
    rows,
    counts,
  };
}

/**
 * **Change one by hand**: an `admin` price for one asset at an `upcoming`
 * event, audited as `asset_price.set` with the reason. `price` is in units of
 * $0.1M. Refuses a blank reason (`reason_required`), a price outside
 * $3M–$34M or not a whole unit (`invalid`), an event or asset not in the game
 * (`not_found`), and an event that has opened (`prices_frozen`).
 */
export async function setAdminPrice(
  db: Db,
  now: Date,
  actor: StaffActor,
  input: {
    gameId: string;
    eventId: string;
    assetId: string;
    price: number;
    reason: string;
  },
): Promise<{ price: number }> {
  const reason = requireReason(input.reason);
  const { gameId, eventId, assetId, price } = input;
  if (!Number.isInteger(price) || price < PRICE_MIN || price > PRICE_MAX) {
    throw new StaffError("invalid", `price ${price} is outside 30-340`);
  }
  const [event] = await db
    .select({ status: gameEvents.status })
    .from(gameEvents)
    .where(and(eq(gameEvents.gameId, gameId), eq(gameEvents.eventId, eventId)));
  if (!event) throw new StaffError("not_found", `no event ${eventId}`);
  if (event.status !== "upcoming") {
    throw new StaffError(
      "prices_frozen",
      `event ${eventId} is ${event.status}`,
    );
  }
  const [asset] = await db
    .select({ id: poolAssets.id })
    .from(poolAssets)
    .where(and(eq(poolAssets.gameId, gameId), eq(poolAssets.id, assetId)));
  if (!asset) throw new StaffError("not_found", `no asset ${assetId}`);

  await publishPrices(db, now, {
    gameId,
    eventId,
    prices: [{ assetId, price }],
    source: "admin",
    reason,
    actor,
  });
  return { price };
}
