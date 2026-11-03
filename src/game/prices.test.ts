import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import { loadPrices2026, seedGame2026 } from "../../tests/helpers/game-2026";
import {
  assetPrices,
  auditLog,
  events,
  gameEvents,
  PRICE_MAX,
  PRICE_MIN,
} from "@/db/schema";
import type { StaffActor } from "@/staff/roster";
import { withdrawPoolAsset } from "./pool";
import { carryPrices, priceList, publishPrices } from "./prices";

// Per-event prices over the recorded 2026 reference data.

const NOW = new Date("2026-02-01T09:00:00.000Z");
const ACTOR: StaffActor = { kind: "admin", label: "staff" };
const CHECK_VIOLATION = "23514";
const RESTRICT_VIOLATION = "23001";

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

describe("per-event prices (DM 3.5)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let game: Awaited<ReturnType<typeof seedGame2026>>;

  beforeEach(async () => {
    t = await createTestDb();
    game = await seedGame2026(t.db, NOW);
  });
  afterEach(async () => {
    await t.close();
  });

  const eventOf = async (round: number) => {
    const [row] = await t.db
      .select()
      .from(events)
      .where(eq(events.round, round));
    return row!;
  };
  const list = async (round: number) =>
    priceList(t.db, {
      gameId: game.gameId,
      eventId: (await eventOf(round)).id,
    });
  const pricesRows = (eventId: string) =>
    t.db.select().from(assetPrices).where(eq(assetPrices.eventId, eventId));

  it("seeding publishes the starting list for round 1", async () => {
    const round1 = await eventOf(1);
    const prices = await list(1);
    expect(prices.size).toBe(33);
    expect(prices.get(await game.assetId("norris"))).toBe(280);
    expect(prices.get(await game.assetId("cadillac"))).toBe(40);
    const [ge] = await t.db
      .select()
      .from(gameEvents)
      .where(eq(gameEvents.eventId, round1.id));
    expect(ge!.pricesReadyAt).toEqual(NOW);
    expect(
      (await pricesRows(round1.id)).every((r) => r.source === "initial"),
    ).toBe(true);
  });

  it("a price outside $3M–$34M is refused", async () => {
    const round1 = await eventOf(1);
    const assetId = await game.assetId("norris");
    // The database refuses it on its own...
    for (const price of [PRICE_MIN - 1, PRICE_MAX + 1]) {
      await expectPgError(
        t.db
          .update(assetPrices)
          .set({ price })
          .where(
            and(
              eq(assetPrices.assetId, assetId),
              eq(assetPrices.eventId, round1.id),
            ),
          ),
        CHECK_VIOLATION,
      );
    }
    // ...and so does publishing, before it writes anything.
    await expect(
      publishPrices(t.db, NOW, {
        gameId: game.gameId,
        eventId: (await eventOf(2)).id,
        source: "initial",
        prices: [{ assetId, price: PRICE_MAX + 1 }],
      }),
    ).rejects.toThrow(/outside/);
  });

  it("prices for a locked event can't change", async () => {
    const round1 = await eventOf(1);
    const assetId = await game.assetId("norris");
    await t.db
      .update(gameEvents)
      .set({ status: "locked" })
      .where(eq(gameEvents.eventId, round1.id));
    const where = and(
      eq(assetPrices.assetId, assetId),
      eq(assetPrices.eventId, round1.id),
    );
    await expectPgError(
      t.db.update(assetPrices).set({ price: 281 }).where(where),
      RESTRICT_VIOLATION,
    );
    await expectPgError(
      t.db.delete(assetPrices).where(where),
      RESTRICT_VIOLATION,
    );
    expect((await list(1)).get(assetId)).toBe(280);

    await expect(
      publishPrices(t.db, NOW, {
        gameId: game.gameId,
        eventId: round1.id,
        source: "admin",
        prices: [{ assetId, price: 281 }],
        reason: "late fix",
        actor: ACTOR,
      }),
    ).rejects.toThrow(/locked/);
    await expect(
      carryPrices(t.db, NOW, { gameId: game.gameId, eventId: round1.id }),
    ).rejects.toThrow(/locked/);
  });

  it("an admin price is audited and replaces the old one", async () => {
    const round1 = await eventOf(1);
    const assetId = await game.assetId("norris");
    await publishPrices(t.db, new Date("2026-02-02T00:00:00Z"), {
      gameId: game.gameId,
      eventId: round1.id,
      source: "admin",
      prices: [
        { assetId, price: 290 },
        { assetId: await game.assetId("piastri"), price: 250 },
      ],
      reason: "Rebalanced",
      actor: ACTOR,
    });
    expect((await list(1)).get(assetId)).toBe(290);
    const rows = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "asset_price.set"));
    // Piastri's price did not change (but its source did), so both are audited.
    expect(rows).toHaveLength(2);
    const norris = rows.find((r) => r.entityId === assetId)!;
    expect(norris.before).toEqual({
      eventId: round1.id,
      price: 280,
      source: "initial",
    });
    expect(norris.after).toEqual({
      eventId: round1.id,
      price: 290,
      source: "admin",
    });
    expect(norris.reason).toBe("Rebalanced");
  });

  it("an admin price without a reason is refused before any write", async () => {
    const round1 = await eventOf(1);
    const assetId = await game.assetId("norris");
    const input = {
      gameId: game.gameId,
      eventId: round1.id,
      source: "admin" as const,
      prices: [{ assetId, price: 290 }],
    };
    await expect(
      publishPrices(t.db, NOW, { ...input, reason: " ", actor: ACTOR }),
    ).rejects.toThrow(/reason/);
    await expect(
      publishPrices(t.db, NOW, { ...input, reason: "why" }),
    ).rejects.toThrow(/actor/);
    expect((await list(1)).get(assetId)).toBe(280);
    expect(await t.db.select().from(auditLog)).toHaveLength(0);
  });

  it("carryPrices copies the last price, including for a withdrawn asset", async () => {
    const round2 = await eventOf(2);
    const bottas = await game.assetId("bottas");
    await withdrawPoolAsset(t.db, NOW, {
      assetId: bottas,
      fromEventId: round2.id,
      reason: "Out for the season",
      actor: ACTOR,
    });
    // An admin price on round 2 for one asset is kept; the rest are carried.
    await publishPrices(t.db, NOW, {
      gameId: game.gameId,
      eventId: round2.id,
      source: "admin",
      prices: [{ assetId: await game.assetId("norris"), price: 300 }],
      reason: "Rebalanced",
      actor: ACTOR,
    });

    const later = new Date("2026-02-10T00:00:00Z");
    expect(
      await carryPrices(t.db, later, {
        gameId: game.gameId,
        eventId: round2.id,
      }),
    ).toBe(32);

    const prices = await list(2);
    expect(prices.size).toBe(33);
    expect(prices.get(bottas)).toBe(36);
    expect(prices.get(await game.assetId("norris"))).toBe(300);
    const rows = await pricesRows(round2.id);
    expect(rows.filter((r) => r.source === "carried")).toHaveLength(32);
    expect(rows.find((r) => r.assetId === bottas)!.source).toBe("carried");

    // The next event carries what round 2 stands at, not round 1's.
    expect(
      await carryPrices(t.db, later, {
        gameId: game.gameId,
        eventId: (await eventOf(3)).id,
      }),
    ).toBe(33);
    expect((await list(3)).get(await game.assetId("norris"))).toBe(300);
  });

  it("carrying again writes nothing", async () => {
    const round2 = await eventOf(2);
    const input = { gameId: game.gameId, eventId: round2.id };
    const first = new Date("2026-02-10T00:00:00Z");
    expect(await carryPrices(t.db, first, input)).toBe(33);
    const before = await pricesRows(round2.id);
    expect(
      await carryPrices(t.db, new Date("2026-02-11T00:00:00Z"), input),
    ).toBe(0);
    expect(await pricesRows(round2.id)).toEqual(before);
    const [ge] = await t.db
      .select()
      .from(gameEvents)
      .where(eq(gameEvents.eventId, round2.id));
    expect(ge!.pricesReadyAt).toEqual(first);
  });
});

describe("the 2026 starting prices (decision 3)", () => {
  const { drivers, constructors } = loadPrices2026();
  const cost = (table: Record<string, number>, count: number, high: boolean) =>
    Object.values(table)
      .sort((a, b) => (high ? b - a : a - b))
      .slice(0, count)
      .reduce((sum, p) => sum + p, 0);

  it("the 2026 starting prices fit the bounds", () => {
    for (const price of [
      ...Object.values(drivers),
      ...Object.values(constructors),
    ]) {
      expect(Number.isInteger(price)).toBe(true);
      expect(price).toBeGreaterThanOrEqual(PRICE_MIN);
      expect(price).toBeLessThanOrEqual(PRICE_MAX);
    }
  });

  it("the cap binds", () => {
    expect(
      cost(drivers, 5, true) + cost(constructors, 2, true),
    ).toBeGreaterThan(1000);
  });

  it("a full team fits", () => {
    expect(
      cost(drivers, 5, false) + cost(constructors, 2, false),
    ).toBeLessThanOrEqual(1000);
  });
});
