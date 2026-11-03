import { and, asc, eq, gte, isNull, lte, or } from "drizzle-orm";
import { writeAudit } from "@/audit/log";
import {
  circuits,
  constructorSeasons,
  events,
  games,
  poolAssets,
  seatAssignments,
  sessions,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { newId } from "@/lib/ids";
import type { MoneyUnits } from "@/lib/money";
import { localDate } from "@/reference/sync-event-entries";
import { audit, requireReason, type StaffActor } from "@/staff/roster";
import { loadGameEvent, upsertPrices } from "./prices";

// The pool: the drivers and constructors a game can pick (DM 3.4). Reads
// reference data, never writes it (DM 0.5).

/**
 * Adds an `active` asset for every constructor of the game's season and every
 * driver with a `race` seat on the date of `fromEventId`'s first session (a
 * date in the circuit's own zone, as for event entries). New assets start at
 * `fromEventId`. Returns how many it added; running it again adds nothing.
 */
export async function seedPool(
  db: Db,
  now: Date,
  input: { gameId: string; fromEventId: string },
): Promise<{ drivers: number; constructors: number }> {
  const { gameId, fromEventId } = input;
  return db.transaction(async (tx) => {
    const [game] = await tx.select().from(games).where(eq(games.id, gameId));
    if (!game) throw new Error(`seedPool: no game ${gameId}`);
    await loadGameEvent(tx, gameId, fromEventId);

    const [event] = await tx
      .select({ timezone: circuits.timezone })
      .from(events)
      .innerJoin(circuits, eq(circuits.id, events.circuitId))
      .where(eq(events.id, fromEventId));
    const [first] = await tx
      .select({ start: sessions.scheduledStart })
      .from(sessions)
      .where(eq(sessions.eventId, fromEventId))
      .orderBy(asc(sessions.scheduledStart))
      .limit(1);
    if (!event || !first) {
      throw new Error(`seedPool: event ${fromEventId} has no sessions`);
    }
    const day = localDate(first.start, event.timezone);

    const driverIds = new Set(
      (
        await tx
          .select({ driverId: seatAssignments.driverId })
          .from(seatAssignments)
          .where(
            and(
              eq(seatAssignments.seasonId, game.seasonId),
              eq(seatAssignments.role, "race"),
              lte(seatAssignments.validFrom, day),
              or(
                isNull(seatAssignments.validTo),
                gte(seatAssignments.validTo, day),
              ),
            ),
          )
      ).map((row) => row.driverId),
    );
    const constructorIds = (
      await tx
        .select({ id: constructorSeasons.constructorId })
        .from(constructorSeasons)
        .where(eq(constructorSeasons.seasonId, game.seasonId))
    ).map((row) => row.id);

    const pooled = await tx
      .select()
      .from(poolAssets)
      .where(eq(poolAssets.gameId, gameId));
    const haveDriver = new Set(pooled.map((a) => a.driverId));
    const haveConstructor = new Set(pooled.map((a) => a.constructorId));

    const base = {
      gameId,
      status: "active" as const,
      addedFromEventId: fromEventId,
      createdAt: now,
      updatedAt: now,
    };
    const newDrivers = [...driverIds]
      .filter((id) => !haveDriver.has(id))
      .map((driverId) => ({
        ...base,
        id: newId(),
        assetType: "driver" as const,
        driverId,
      }));
    const newConstructors = constructorIds
      .filter((id) => !haveConstructor.has(id))
      .map((constructorId) => ({
        ...base,
        id: newId(),
        assetType: "constructor" as const,
        constructorId,
      }));
    const rows = [...newDrivers, ...newConstructors];
    if (rows.length > 0) await tx.insert(poolAssets).values(rows);
    return { drivers: newDrivers.length, constructors: newConstructors.length };
  });
}

/**
 * Adds a mid-season substitute to the pool (HLD §8.1): exactly one of
 * `driverId` and `constructorId`, pickable from `fromEventId`, with its `admin`
 * price for that event. The asset, the price and their audit rows are written
 * in one transaction. Does not touch the event's `prices_ready_at`: the rest of
 * its list is not this call's to publish. Returns the asset's id.
 *
 * Refuses, writing nothing: a blank reason, a price outside 30-340, both or
 * neither of driver and constructor, an asset already in the pool, and an
 * event that isn't `upcoming` or `open`.
 */
export async function addPoolAsset(
  db: Db,
  now: Date,
  input: {
    gameId: string;
    driverId?: string;
    constructorId?: string;
    fromEventId: string;
    price: MoneyUnits;
    reason: string;
    actor: StaffActor;
  },
): Promise<string> {
  const reason = requireReason(input.reason);
  const { gameId, driverId, constructorId, fromEventId } = input;
  if ((driverId === undefined) === (constructorId === undefined)) {
    throw new Error("a pool asset is exactly one of a driver or a constructor");
  }
  const meta = audit(input.actor, reason);

  return db.transaction(async (tx) => {
    const event = await loadGameEvent(tx, gameId, fromEventId);
    if (event.status !== "upcoming" && event.status !== "open") {
      throw new Error(
        `event ${fromEventId} is ${event.status}: a pool asset can only start at an upcoming or open event`,
      );
    }
    const [existing] = await tx
      .select({ id: poolAssets.id })
      .from(poolAssets)
      .where(
        and(
          eq(poolAssets.gameId, gameId),
          driverId !== undefined
            ? eq(poolAssets.driverId, driverId)
            : eq(poolAssets.constructorId, constructorId!),
        ),
      );
    if (existing) {
      throw new Error(`game ${gameId} already has that asset in its pool`);
    }

    const assetId = newId();
    const subject =
      driverId !== undefined
        ? { assetType: "driver" as const, driverId }
        : { assetType: "constructor" as const, constructorId: constructorId! };
    await tx.insert(poolAssets).values({
      id: assetId,
      gameId,
      ...subject,
      status: "active",
      addedFromEventId: fromEventId,
      createdAt: now,
      updatedAt: now,
    });
    await writeAudit(tx, now, {
      ...meta,
      action: "pool_asset.create",
      entityType: "pool_asset",
      entityId: assetId,
      before: null,
      after: { gameId, ...subject, addedFromEventId: fromEventId },
    });
    await upsertPrices(tx, now, {
      gameId,
      eventId: fromEventId,
      prices: [{ assetId, price: input.price }],
      source: "admin",
      meta,
    });
    return assetId;
  });
}

/**
 * Withdraws an asset from `fromEventId`: it can't be bought any more, but its
 * row and prices stay, since owners keep it and its penalties (DM 3.4).
 * Audited. An asset already withdrawn is left as it is, with no audit row.
 */
export async function withdrawPoolAsset(
  db: Db,
  now: Date,
  input: {
    assetId: string;
    fromEventId: string;
    reason: string;
    actor: StaffActor;
  },
): Promise<void> {
  const reason = requireReason(input.reason);
  const meta = audit(input.actor, reason);
  await db.transaction(async (tx) => {
    const [asset] = await tx
      .select()
      .from(poolAssets)
      .where(eq(poolAssets.id, input.assetId));
    if (!asset) throw new Error(`no pool asset ${input.assetId}`);
    await loadGameEvent(tx, asset.gameId, input.fromEventId);
    if (asset.status === "withdrawn") return;

    await tx
      .update(poolAssets)
      .set({
        status: "withdrawn",
        withdrawnFromEventId: input.fromEventId,
        updatedAt: now,
      })
      .where(eq(poolAssets.id, input.assetId));
    await writeAudit(tx, now, {
      ...meta,
      action: "pool_asset.withdraw",
      entityType: "pool_asset",
      entityId: input.assetId,
      before: { status: asset.status, withdrawnFromEventId: null },
      after: {
        status: "withdrawn",
        withdrawnFromEventId: input.fromEventId,
      },
    });
  });
}
