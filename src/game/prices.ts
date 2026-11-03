import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "@/audit/log";
import {
  assetPrices,
  events,
  gameEvents,
  poolAssets,
  PRICE_MAX,
  PRICE_MIN,
  type GAME_EVENT_STATUSES,
  type PRICE_SOURCES,
} from "@/db/schema";
import type { Db } from "@/db/types";
import type { MoneyUnits } from "@/lib/money";
import { audit, requireReason, type StaffActor } from "@/staff/roster";

// Per-event prices (DM 3.5). Reads reference data, never writes it (DM 0.5).
// Each event has its own price list, frozen once the event locks (trigger), so
// a price already paid can always be explained. The formula that sets prices
// after an event is M4's; this is where they are stored and read.

type GameEventStatus = (typeof GAME_EVENT_STATUSES)[number];
type PriceSource = (typeof PRICE_SOURCES)[number];

/** A game event in one of these statuses has frozen prices. */
const FROZEN: readonly GameEventStatus[] = ["locked", "scored", "final"];
/**
 * From `open` on, an event's prices are fixed (game_rules_5): saves are checked
 * against them. Only a price for an asset that has none may still be added
 * (`carryPrices`, a substitute), until the event locks. A cancelled event's
 * stay fixed too (game_rules_8): the next event carries them.
 */
const FIXED: readonly GameEventStatus[] = ["open", ...FROZEN, "cancelled"];

export interface PriceInput {
  assetId: string;
  price: MoneyUnits;
}

/** The game's row for an event, or an error naming what is missing. */
export async function loadGameEvent(db: Db, gameId: string, eventId: string) {
  const [row] = await db
    .select()
    .from(gameEvents)
    .where(and(eq(gameEvents.gameId, gameId), eq(gameEvents.eventId, eventId)));
  if (!row) throw new Error(`game ${gameId} has no event ${eventId}`);
  return row;
}

/** Refuses a price outside the game's bounds before anything is written. */
function checkPrice(price: MoneyUnits): void {
  if (!Number.isInteger(price) || price < PRICE_MIN || price > PRICE_MAX) {
    throw new RangeError(
      `price ${price} is outside ${PRICE_MIN}-${PRICE_MAX} units of $0.1M`,
    );
  }
}

/**
 * Writes `prices` for an event, one row per asset, and returns how many rows
 * changed. A price already stored with the same value and source is left as it
 * is. With `meta`, each change is audited in the caller's transaction.
 * Does not touch `prices_ready_at`.
 */
export async function upsertPrices(
  tx: Db,
  now: Date,
  input: {
    gameId: string;
    eventId: string;
    prices: PriceInput[];
    source: PriceSource;
    meta?: ReturnType<typeof audit>;
  },
): Promise<number> {
  const { gameId, eventId, prices, source, meta } = input;
  const ids = prices.map((p) => p.assetId);
  if (new Set(ids).size !== ids.length) {
    throw new Error("a price list names an asset twice");
  }
  for (const { price } of prices) checkPrice(price);

  const assets = await tx
    .select({ id: poolAssets.id })
    .from(poolAssets)
    .where(and(eq(poolAssets.gameId, gameId), inArray(poolAssets.id, ids)));
  if (assets.length !== ids.length) {
    const known = new Set(assets.map((a) => a.id));
    throw new Error(
      `assets not in game ${gameId}: ${ids.filter((id) => !known.has(id)).join(", ")}`,
    );
  }
  const stored = new Map(
    (
      await tx
        .select()
        .from(assetPrices)
        .where(
          and(
            eq(assetPrices.eventId, eventId),
            inArray(assetPrices.assetId, ids),
          ),
        )
    ).map((row) => [row.assetId, row]),
  );

  let changed = 0;
  for (const { assetId, price } of prices) {
    const before = stored.get(assetId);
    if (before && before.price === price && before.source === source) continue;
    await tx
      .insert(assetPrices)
      .values({
        assetId,
        eventId,
        price,
        source,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [assetPrices.assetId, assetPrices.eventId],
        set: { price, source, updatedAt: now },
      });
    if (meta) {
      await writeAudit(tx, now, {
        ...meta,
        action: "asset_price.set",
        entityType: "asset_price",
        entityId: assetId,
        before: before
          ? { eventId, price: before.price, source: before.source }
          : null,
        after: { eventId, price, source },
      });
    }
    changed += 1;
  }
  return changed;
}

/** One row of `team_base_state`'s owned assets: an asset id. */
const ownedRowSchema = z.object({ asset_id: z.string() });

/**
 * The assets an event's price list must have, by id: every asset pickable at
 * the event and every one a team owns going into it. Both are placed by
 * sequence, as the lineup check places them (`game_event_sequence_from`), not
 * by the pool's `status`, which says `withdrawn` from the moment an asset is
 * withdrawn, whatever event it goes from:
 * - pickable: added from this event or an earlier one (one added from a
 *   cancelled event counts from the event after it), and not withdrawn by it;
 * - owned: in an active team's base lineup for the event (`team_base_state`),
 *   such as an asset withdrawn since the team bought it, which it keeps.
 */
export async function neededAssetIds(
  tx: Db,
  gameId: string,
  event: { eventId: string; sequence: number },
): Promise<Set<string>> {
  const pickable = await tx
    .select({ id: poolAssets.id })
    .from(poolAssets)
    .where(
      and(
        eq(poolAssets.gameId, gameId),
        sql`game_event_sequence_from(${poolAssets.gameId}, ${poolAssets.addedFromEventId}) <= ${event.sequence}`,
        sql`not coalesce((${poolAssets.status} = 'withdrawn' and ${poolAssets.withdrawnFromEventId} is null)
              or game_event_sequence_from(${poolAssets.gameId}, ${poolAssets.withdrawnFromEventId}) <= ${event.sequence}, false)`,
      ),
    );
  const { rows } = (await tx.execute(sql`
    select distinct lp."asset_id" as asset_id
    from "teams" t
    cross join lateral team_base_state(t."id", ${event.eventId}::uuid) b
    join "lineup_picks" lp on lp."lineup_version_id" = b."base_version_id"
    where t."game_id" = ${gameId} and t."status" = 'active'
  `)) as { rows: unknown[] };
  return new Set([
    ...pickable.map((a) => a.id),
    ...z
      .array(ownedRowSchema)
      .parse(rows)
      .map((row) => row.asset_id),
  ]);
}

/** True when every asset the event needs (`neededAssetIds`) has a price. */
async function isComplete(
  tx: Db,
  gameId: string,
  event: { eventId: string; sequence: number },
): Promise<boolean> {
  const priced = new Set(
    (
      await tx
        .select({ assetId: assetPrices.assetId })
        .from(assetPrices)
        .where(eq(assetPrices.eventId, event.eventId))
    ).map((row) => row.assetId),
  );
  return [...(await neededAssetIds(tx, gameId, event))].every((id) =>
    priced.has(id),
  );
}

/**
 * Publishes an event's prices: upserts them and, once the list is complete,
 * sets `prices_ready_at`, from when builders see it. Complete means every
 * asset the event needs (`neededAssetIds`: pickable there, or owned going
 * into it) has a price for it; a partial list, such as a single admin
 * correction, leaves `prices_ready_at` as it was. Opening the event always
 * runs `carryPrices`, which fills any gap left.
 * `initial` is the season's starting list; `admin` is a staff correction,
 * which needs a reason and an actor and is audited in the same transaction.
 * Refuses, writing nothing: a blank reason, a price outside 30-340, an asset
 * from another game, and an event that has opened (its prices are fixed from
 * then, DM 3.5) or locked.
 */
export async function publishPrices(
  db: Db,
  now: Date,
  input: {
    gameId: string;
    eventId: string;
    prices: PriceInput[];
    source: "initial" | "admin";
    reason?: string;
    actor?: StaffActor;
  },
): Promise<void> {
  let meta: ReturnType<typeof audit> | undefined;
  if (input.source === "admin") {
    if (!input.actor) throw new Error("an admin price needs an actor");
    meta = audit(input.actor, requireReason(input.reason ?? ""));
  }
  await db.transaction(async (tx) => {
    const event = await loadGameEvent(tx, input.gameId, input.eventId);
    if (FIXED.includes(event.status)) {
      throw new Error(
        `event ${input.eventId} is ${event.status}: its prices are fixed once it opens, and when it is cancelled`,
      );
    }
    await upsertPrices(tx, now, { ...input, meta });
    if (
      event.sequence !== null &&
      (await isComplete(tx, input.gameId, {
        eventId: input.eventId,
        sequence: event.sequence,
      }))
    ) {
      await tx
        .update(gameEvents)
        .set({ pricesReadyAt: now, updatedAt: now })
        .where(
          and(
            eq(gameEvents.gameId, input.gameId),
            eq(gameEvents.eventId, input.eventId),
          ),
        );
    }
  });
}

/**
 * Gives every asset with no price for the event its latest earlier price, as
 * `carried` (DM 3.5: no update ran before the lock, so the previous price
 * stands). Withdrawn assets are carried too, since owners keep them. "Earlier"
 * is the game's earlier events (by sequence) and its cancelled events, latest
 * by lock time, so an asset added for a later event has nothing to carry, and
 * prices don't change across a cancellation (DM 3.9): the event after one
 * cancelled takes the cancelled event's list, which lineups were saved
 * against. That completes the list, so it sets `prices_ready_at` if it isn't
 * set, and returns the rows written; running it again writes nothing. It must
 * run before the event locks, which freezes the list.
 */
export async function carryPrices(
  db: Db,
  now: Date,
  input: { gameId: string; eventId: string },
): Promise<number> {
  const { gameId, eventId } = input;
  return db.transaction(async (tx) => {
    const event = await loadGameEvent(tx, gameId, eventId);
    if (FROZEN.includes(event.status)) {
      throw new Error(`event ${eventId} has locked: its prices are fixed`);
    }
    if (event.sequence === null) {
      throw new Error(`event ${eventId} is cancelled: it has no prices`);
    }

    const here = new Set(
      (
        await tx
          .select({ assetId: assetPrices.assetId })
          .from(assetPrices)
          .where(eq(assetPrices.eventId, eventId))
      ).map((row) => row.assetId),
    );
    const [own] = await tx
      .select({ lockAt: events.lockAt })
      .from(events)
      .where(eq(events.id, eventId));
    const earlier = await tx
      .select({
        assetId: assetPrices.assetId,
        price: assetPrices.price,
        lockAt: events.lockAt,
      })
      .from(assetPrices)
      .innerJoin(poolAssets, eq(poolAssets.id, assetPrices.assetId))
      .innerJoin(
        gameEvents,
        and(
          eq(gameEvents.gameId, poolAssets.gameId),
          eq(gameEvents.eventId, assetPrices.eventId),
        ),
      )
      .innerJoin(events, eq(events.id, gameEvents.eventId))
      .where(
        and(
          eq(poolAssets.gameId, gameId),
          or(
            lt(gameEvents.sequence, event.sequence),
            and(
              eq(gameEvents.status, "cancelled"),
              lt(events.lockAt, own!.lockAt),
            ),
          ),
        ),
      );
    const latest = new Map<string, { price: number; lockAt: number }>();
    for (const row of earlier) {
      const seen = latest.get(row.assetId);
      if (!seen || row.lockAt.getTime() > seen.lockAt) {
        latest.set(row.assetId, {
          price: row.price,
          lockAt: row.lockAt.getTime(),
        });
      }
    }

    const rows = [...latest]
      .filter(([assetId]) => !here.has(assetId))
      .map(([assetId, { price }]) => ({
        assetId,
        eventId,
        price,
        source: "carried" as const,
        createdAt: now,
        updatedAt: now,
      }));
    if (rows.length > 0) await tx.insert(assetPrices).values(rows);
    if (event.pricesReadyAt === null) {
      await tx
        .update(gameEvents)
        .set({ pricesReadyAt: now, updatedAt: now })
        .where(
          and(eq(gameEvents.gameId, gameId), eq(gameEvents.eventId, eventId)),
        );
    }
    return rows.length;
  });
}

/** The event's price list, by asset id. */
export async function priceList(
  db: Db,
  input: { gameId: string; eventId: string },
): Promise<Map<string, MoneyUnits>> {
  const rows = await db
    .select({ assetId: assetPrices.assetId, price: assetPrices.price })
    .from(assetPrices)
    .innerJoin(poolAssets, eq(poolAssets.id, assetPrices.assetId))
    .where(
      and(
        eq(poolAssets.gameId, input.gameId),
        eq(assetPrices.eventId, input.eventId),
      ),
    );
  return new Map(rows.map((row) => [row.assetId, row.price]));
}
