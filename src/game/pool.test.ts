import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import { seedGame2026 } from "../../tests/helpers/game-2026";
import {
  assetPrices,
  auditLog,
  constructors,
  events,
  gameEvents,
  poolAssets,
} from "@/db/schema";
import { newId } from "@/lib/ids";
import type { StaffActor } from "@/staff/roster";
import { addPoolAsset, seedPool, withdrawPoolAsset } from "./pool";
import { priceList } from "./prices";

// The pool over the recorded 2026 reference data: who can be picked, and the
// admin changes to it.

const NOW = new Date("2026-02-01T09:00:00.000Z");
const ACTOR: StaffActor = { kind: "admin", label: "staff" };
const CHECK_VIOLATION = "23514";

/** As in game.test.ts: the SQLSTATE is on the error or its cause. */
async function expectPgError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, "expected the statement to be rejected").toBeDefined();
  const direct = (error as { code?: string }).code;
  const cause = (error as { cause?: { code?: string } }).cause?.code;
  expect(direct ?? cause).toBe(code);
}

describe("the pool (DM 3.4)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let game: Awaited<ReturnType<typeof seedGame2026>>;

  beforeEach(async () => {
    t = await createTestDb();
    game = await seedGame2026(t.db, NOW);
  });
  afterEach(async () => {
    await t.close();
  });

  const pool = () =>
    t.db.select().from(poolAssets).where(eq(poolAssets.gameId, game.gameId));
  const eventOf = async (round: number) => {
    const [row] = await t.db
      .select()
      .from(events)
      .where(eq(events.round, round));
    return row!;
  };

  it("the 2026 pool has 22 drivers and 11 constructors", async () => {
    const assets = await pool();
    expect(assets.filter((a) => a.assetType === "driver")).toHaveLength(22);
    expect(assets.filter((a) => a.assetType === "constructor")).toHaveLength(
      11,
    );
    const round1 = await eventOf(1);
    expect(assets.every((a) => a.status === "active")).toBe(true);
    expect(assets.every((a) => a.addedFromEventId === round1.id)).toBe(true);
  });

  it("seeding again adds nothing", async () => {
    const round1 = await eventOf(1);
    const before = await pool();
    expect(
      await seedPool(t.db, NOW, {
        gameId: game.gameId,
        fromEventId: round1.id,
      }),
    ).toEqual({ drivers: 0, constructors: 0 });
    expect(await pool()).toEqual(before);
  });

  it("a pool asset must be exactly one of driver or constructor", async () => {
    const [existing] = await pool();
    const [team] = await t.db.select().from(constructors).limit(1);
    const base = {
      id: newId(),
      gameId: game.gameId,
      status: "active" as const,
      addedFromEventId: existing!.addedFromEventId,
    };
    const driverId = (await pool()).find((a) => a.driverId)!.driverId!;
    await expectPgError(
      t.db.insert(poolAssets).values({
        ...base,
        assetType: "driver",
        driverId,
        constructorId: team!.id,
      }),
      CHECK_VIOLATION,
    );
    await expectPgError(
      t.db.insert(poolAssets).values({ ...base, assetType: "driver" }),
      CHECK_VIOLATION,
    );
    // The type has to name the id that is set.
    await expectPgError(
      t.db
        .insert(poolAssets)
        .values({ ...base, assetType: "constructor", driverId }),
      CHECK_VIOLATION,
    );
  });

  it("a substitute added for round 13 has an admin price there and an audit row", async () => {
    const round13 = await eventOf(13);
    const tsunoda = await t.db.query.providerIds.findFirst({
      where: (p, { and, eq }) =>
        and(eq(p.providerKey, "tsunoda"), eq(p.entityType, "driver")),
    });
    const assetId = await addPoolAsset(t.db, NOW, {
      gameId: game.gameId,
      driverId: tsunoda!.entityId,
      fromEventId: round13.id,
      price: 56,
      reason: "Replaces an injured driver",
      actor: ACTOR,
    });

    expect(await game.assetId("tsunoda")).toBe(assetId);
    const [asset] = await t.db
      .select()
      .from(poolAssets)
      .where(eq(poolAssets.id, assetId));
    expect(asset).toMatchObject({
      status: "active",
      addedFromEventId: round13.id,
    });
    const [price] = await t.db
      .select()
      .from(assetPrices)
      .where(eq(assetPrices.assetId, assetId));
    expect(price).toMatchObject({
      eventId: round13.id,
      price: 56,
      source: "admin",
    });
    expect(
      (await priceList(t.db, { gameId: game.gameId, eventId: round13.id })).get(
        assetId,
      ),
    ).toBe(56);

    const rows = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, assetId));
    expect(rows.map((r) => r.action).sort()).toEqual([
      "asset_price.set",
      "pool_asset.create",
    ]);
    expect(rows.every((r) => r.reason === "Replaces an injured driver")).toBe(
      true,
    );
    expect(rows.every((r) => r.actorLabel === "staff")).toBe(true);
  });

  it("a substitute is refused when the event has locked, or with a blank reason", async () => {
    const round13 = await eventOf(13);
    const tsunoda = await t.db.query.providerIds.findFirst({
      where: (p, { and, eq }) =>
        and(eq(p.providerKey, "tsunoda"), eq(p.entityType, "driver")),
    });
    const input = {
      gameId: game.gameId,
      driverId: tsunoda!.entityId,
      fromEventId: round13.id,
      price: 56,
      reason: "Replaces an injured driver",
      actor: ACTOR,
    };
    await expect(
      addPoolAsset(t.db, NOW, { ...input, reason: "  " }),
    ).rejects.toThrow(/reason/);
    await t.db
      .update(gameEvents)
      .set({ status: "locked" })
      .where(eq(gameEvents.eventId, round13.id));
    await expect(addPoolAsset(t.db, NOW, input)).rejects.toThrow(/locked/);
    await expect(
      addPoolAsset(t.db, NOW, {
        ...input,
        constructorId: "x",
      }),
    ).rejects.toThrow(/exactly one/);
    expect(await pool()).toHaveLength(33);
    expect(
      await t.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityType, "pool_asset")),
    ).toHaveLength(0);
  });

  it("withdrawing keeps the asset's rows", async () => {
    const round2 = await eventOf(2);
    const round1 = await eventOf(1);
    const assetId = await game.assetId("bottas");
    await withdrawPoolAsset(t.db, NOW, {
      assetId,
      fromEventId: round2.id,
      reason: "Out for the season",
      actor: ACTOR,
    });

    const [asset] = await t.db
      .select()
      .from(poolAssets)
      .where(eq(poolAssets.id, assetId));
    expect(asset).toMatchObject({
      status: "withdrawn",
      withdrawnFromEventId: round2.id,
    });
    expect(await pool()).toHaveLength(33);
    expect(
      (await priceList(t.db, { gameId: game.gameId, eventId: round1.id })).get(
        assetId,
      ),
    ).toBe(36);
    const [row] = await t.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityId, assetId),
          eq(auditLog.action, "pool_asset.withdraw"),
        ),
      );
    expect(row).toMatchObject({ reason: "Out for the season" });

    // Withdrawing again changes nothing and writes no second audit row.
    await withdrawPoolAsset(t.db, NOW, {
      assetId,
      fromEventId: round2.id,
      reason: "Out for the season",
      actor: ACTOR,
    });
    expect(
      await t.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "pool_asset.withdraw")),
    ).toHaveLength(1);
  });
});
