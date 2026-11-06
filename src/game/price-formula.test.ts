import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import {
  lockRound,
  openRound,
  round2026,
  seedGame2026,
} from "../../tests/helpers/game-2026";
import { sessionOf } from "../../tests/helpers/pipeline-2026";
import {
  assetPrices,
  assetScoreLines,
  events,
  gameEvents,
  priceUpdateRuns,
  scoringRuns,
} from "@/db/schema";
import { newId } from "@/lib/ids";
import { setSimulatedClock } from "@/replay/clock-loop";
import { planGameEvents } from "./games";
import { openGame } from "./lineups";
import { priceChange, runPriceUpdate } from "./price-formula";
import { priceList, publishPrices } from "./prices";
import { withdrawPoolAsset } from "./pool";
import { RULESET_2026 } from "./ruleset";

// The price formula (DM 3.5): the pure step, then the update over the recorded
// 2026 game, whose scores here are hand-written lines on a stub run.

const NOW = new Date("2026-02-01T09:00:00.000Z");
const { formula } = RULESET_2026.prices;
/** The formula with nothing unscored, so a ratio is the plain points over price. */
const plain = {
  ...formula,
  unscoredPoints: { driver: 0, constructor: 0 },
};
const { min, max } = RULESET_2026.prices;
const bounds = { min, max };

/** A price, the points that tier it, and what the band does with them. */
const change = (
  price: number,
  average: number,
  assetType: "driver" | "constructor" = "driver",
  used = plain,
) =>
  priceChange({
    price,
    assetType,
    recentPoints: [average],
    formula: used,
    bounds,
  });

describe("priceChange (pure)", () => {
  it("each tier maps to its change in each band", () => {
    // Expensive: $20M expects 20 points. Ratios 0.25, 0.75, 1 and 2.
    expect([5, 15, 20, 40].map((avg) => change(200, avg))).toEqual([
      { tier: "terrible", change: -3, newPrice: 197 },
      { tier: "poor", change: -1, newPrice: 199 },
      { tier: "good", change: 1, newPrice: 201 },
      { tier: "great", change: 3, newPrice: 203 },
    ]);
    // Cheap: $10M expects 10 points. Ratios 0.3, 0.8, 1 and 2.
    expect([3, 8, 10, 20].map((avg) => change(100, avg))).toEqual([
      { tier: "terrible", change: -6, newPrice: 94 },
      { tier: "poor", change: -2, newPrice: 98 },
      { tier: "good", change: 2, newPrice: 102 },
      { tier: "great", change: 6, newPrice: 106 },
    ]);
  });

  it("a ratio on a threshold takes the higher tier", () => {
    // $10M expects 10 points: ratios 0.6, 0.9 and 1.2 exactly.
    expect([6, 9, 12].map((avg) => change(100, avg).tier)).toEqual([
      "poor",
      "good",
      "great",
    ]);
    expect(change(100, 5.9).tier).toBe("terrible");
  });

  it("an asset at the band split is expensive", () => {
    expect(formula.bandSplit).toBe(185);
    expect(change(185, 100).change).toBe(3);
    expect(change(184, 100).change).toBe(6);
  });

  it("drivers and constructors have their own points per million", () => {
    const own = {
      ...plain,
      pointsPerMillion: { driver: 1, constructor: 2 },
    };
    // 20 points on $10M: a driver's baseline is 10, a constructor's 20.
    const base = { price: 100, recentPoints: [20], formula: own, bounds };
    expect(priceChange({ ...base, assetType: "driver" }).tier).toBe("great");
    expect(priceChange({ ...base, assetType: "constructor" }).tier).toBe(
      "good",
    );
  });

  it("the points the game doesn't score count towards the ratio", () => {
    // 2 points on $10M: a driver's 2 + 6 gives 0.8, a constructor's 2 + 15
    // gives 1.7.
    expect(change(100, 2, "driver", formula).tier).toBe("poor");
    expect(change(100, 2, "constructor", formula).tier).toBe("great");
  });

  it("a price is clamped at $3M and $34M", () => {
    expect(change(340, 1000)).toEqual({
      tier: "great",
      change: 3,
      newPrice: max,
    });
    expect(change(338, 1000).newPrice).toBe(max);
    expect(change(min, 0)).toEqual({
      tier: "terrible",
      change: -6,
      newPrice: min,
    });
    expect(change(32, 0).newPrice).toBe(min);
  });

  it("a version's own bounds clamp the price", () => {
    const bounds = { min: 50, max: 300 };
    const run = (price: number, average: number) =>
      priceChange({
        price,
        assetType: "driver",
        recentPoints: [average],
        formula: plain,
        bounds,
      });
    // Cheap and terrible: 52 - 6 would be 46. Expensive and great: 298 + 3.
    expect(run(52, 0)).toEqual({ tier: "terrible", change: -6, newPrice: 50 });
    expect(run(298, 1000)).toEqual({ tier: "great", change: 3, newPrice: 300 });
    // Inside the bounds nothing is clamped.
    expect(run(100, 20).newPrice).toBe(106);
  });

  it("fewer than three events average what there is", () => {
    const run = (recentPoints: number[]) =>
      priceChange({
        price: 100,
        assetType: "driver",
        recentPoints,
        formula: plain,
        bounds,
      });
    // Averages of 10 in each case: ratio 1, good.
    expect(run([10])).toEqual(run([10, 10, 10]));
    expect(run([8, 12])).toEqual(run([10, 10, 10]));
    expect(run([10]).tier).toBe("good");
  });

  it("only the newest three events count, the last ones in the list", () => {
    const run = (recentPoints: number[]) =>
      priceChange({
        price: 100,
        assetType: "driver",
        recentPoints,
        formula: plain,
        bounds,
      });
    // 100 is the oldest and is outside the window: the average is 3.
    expect(run([100, 3, 3, 3]).tier).toBe("terrible");
    expect(run([3, 3, 3, 100]).tier).toBe("great");
  });

  it("negative average points are terrible", () => {
    expect(change(100, -4)).toEqual({
      tier: "terrible",
      change: -6,
      newPrice: 94,
    });
    expect(
      priceChange({
        price: 250,
        assetType: "constructor",
        recentPoints: [-20, 10],
        formula: plain,
        bounds,
      }).tier,
    ).toBe("terrible");
  });

  it("with no recent events the price stays and there is no tier", () => {
    expect(
      priceChange({
        price: 123,
        assetType: "driver",
        recentPoints: [],
        formula: plain,
        bounds,
      }),
    ).toEqual({ tier: null, change: 0, newPrice: 123 });
  });
});

describe("runPriceUpdate (DM 3.5)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let game: Awaited<ReturnType<typeof seedGame2026>>;
  let gameId: string;
  let rounds: { id: string; lockAt: Date }[];

  beforeEach(async () => {
    t = await createTestDb();
    game = await seedGame2026(t.db, NOW);
    gameId = game.gameId;
    await setSimulatedClock(t.db, NOW);
    rounds = [];
    for (const n of [1, 2, 3, 4]) rounds.push(await round2026(t.db, n));
    await openGame(t.db, NOW, gameId);
  });
  afterEach(async () => {
    await t.close();
  });

  /**
   * Scores a round's race with one line per asset: `points` by Jolpica key. An
   * asset not named has no line, so it scored 0.
   */
  const score = async (
    eventId: string,
    points: Record<string, number>,
    absent: string[] = [],
  ) => {
    const race = await sessionOf(t.db, eventId, "race");
    const [ge] = await t.db
      .select()
      .from(gameEvents)
      .where(eq(gameEvents.eventId, eventId));
    const runId = newId();
    await t.db.insert(scoringRuns).values({
      id: runId,
      gameId,
      sessionId: race.id,
      rulesetVersionId: ge!.rulesetVersionId,
      engineVersion: "test",
      inputFingerprint: `stub-${runId}`,
      trigger: "admin",
      mode: "live",
      status: "succeeded",
      isCurrent: true,
      startedAt: NOW,
      finishedAt: NOW,
    });
    for (const [key, value] of Object.entries(points)) {
      await t.db.insert(assetScoreLines).values({
        id: newId(),
        gameId,
        sessionId: race.id,
        runId,
        assetId: await game.assetId(key),
        ruleCode: "stub",
        category: "race",
        points: value,
        detail: {},
      });
    }
    for (const key of absent) {
      await t.db.insert(assetScoreLines).values({
        id: newId(),
        gameId,
        sessionId: race.id,
        runId,
        assetId: await game.assetId(key),
        ruleCode: "stub_absent",
        category: "race",
        points: -20,
        detail: { reason: "absent" },
      });
    }
  };

  /** Locks the round before `n` and opens round `n`, as the jobs would. */
  const lockOpenThrough = async (n: number) => {
    await lockRound(t.db, gameId, rounds[n - 2]!.id);
    const opened = new Date(rounds[n - 2]!.lockAt.getTime() + 3_600_000);
    await setSimulatedClock(t.db, opened);
    await openRound(t.db, opened, gameId, rounds[n - 1]!.id);
  };
  const update = (afterEventId: string, ranBy = "system") =>
    runPriceUpdate(t.db, NOW, { gameId, afterEventId, ranBy });
  const pricesOf = (eventId: string) => priceList(t.db, { gameId, eventId });

  it("the update writes formula prices and publishes the next event", async () => {
    await score(rounds[0]!.id, {
      norris: 24, // 24 + 6 on $28M: ratio 1.07, good
      piastri: 14, // 14 + 6 on $25M: ratio 0.8, poor
      cadillac: 10, // 10 + 15 on $4M: ratio 6.25, great
    });

    const result = await update(rounds[0]!.id);
    expect(result).toEqual({ runId: expect.any(String) });

    const prices = await pricesOf(rounds[1]!.id);
    expect(prices.size).toBe(33);
    expect(prices.get(await game.assetId("norris"))).toBe(281);
    expect(prices.get(await game.assetId("piastri"))).toBe(249);
    expect(prices.get(await game.assetId("cadillac"))).toBe(46);
    // No line means 0 points. 0 + 6 on $20M is terrible, -3; 0 + 15 on $9M is
    // great, +6.
    expect(prices.get(await game.assetId("leclerc"))).toBe(197);
    expect(prices.get(await game.assetId("haas"))).toBe(96);

    const rows = await t.db
      .select()
      .from(assetPrices)
      .where(eq(assetPrices.eventId, rounds[1]!.id));
    const runId = (result as { runId: string }).runId;
    expect(rows.every((r) => r.source === "formula" && r.runId === runId)).toBe(
      true,
    );
    // Round 1's prices are untouched.
    expect(
      (await pricesOf(rounds[0]!.id)).get(await game.assetId("norris")),
    ).toBe(280);

    const [next] = await t.db
      .select()
      .from(gameEvents)
      .where(eq(gameEvents.eventId, rounds[1]!.id));
    expect(next).toMatchObject({ status: "upcoming", pricesReadyAt: NOW });
  });

  it("the inputs explain every change", async () => {
    await score(rounds[0]!.id, { norris: 24, cadillac: 10 });
    const { runId } = (await update(rounds[0]!.id, "staff:preston")) as {
      runId: string;
    };

    const [run] = await t.db
      .select()
      .from(priceUpdateRuns)
      .where(eq(priceUpdateRuns.id, runId));
    const [ge] = await t.db
      .select()
      .from(gameEvents)
      .where(eq(gameEvents.eventId, rounds[1]!.id));
    expect(run).toMatchObject({
      gameId,
      afterEventId: rounds[0]!.id,
      rulesetVersionId: ge!.rulesetVersionId,
      ranBy: "staff:preston",
      ranAt: NOW,
    });

    const inputs = run!.inputs as {
      eventId: string;
      assets: Record<string, unknown>[];
    };
    expect(inputs.eventId).toBe(rounds[1]!.id);
    expect(inputs.assets).toHaveLength(33);
    const byAsset = new Map(inputs.assets.map((a) => [a.assetId as string, a]));
    expect(byAsset.get(await game.assetId("norris"))).toEqual({
      assetId: await game.assetId("norris"),
      assetType: "driver",
      price: 280,
      recentPoints: [24],
      average: 24,
      ratio: 30 / 28,
      tier: "good",
      change: 1,
      newPrice: 281,
    });
    expect(byAsset.get(await game.assetId("haas"))).toMatchObject({
      assetType: "constructor",
      recentPoints: [0],
      average: 0,
      ratio: 15 / 9,
      tier: "great",
      change: 6,
      newPrice: 96,
    });
    // Every stored price is the one its input says.
    const prices = await pricesOf(rounds[1]!.id);
    for (const [assetId, input] of byAsset) {
      expect(prices.get(assetId)).toBe(input.newPrice);
    }
  });

  it("the last three scored events are averaged, oldest first", async () => {
    // Rounds 1 to 3 scored, then round 4's prices from the three.
    await score(rounds[0]!.id, { norris: 100 });
    expect(await update(rounds[0]!.id)).toHaveProperty("runId");
    await score(rounds[1]!.id, { norris: 20 });
    await lockOpenThrough(2);
    expect(await update(rounds[1]!.id)).toHaveProperty("runId");
    await score(rounds[2]!.id, { norris: 5 });
    await lockOpenThrough(3);
    const { runId } = (await update(rounds[2]!.id)) as { runId: string };

    const [run] = await t.db
      .select()
      .from(priceUpdateRuns)
      .where(eq(priceUpdateRuns.id, runId));
    const norris = await game.assetId("norris");
    const entry = (
      run!.inputs as {
        assets: { assetId: string; recentPoints: number[] }[];
      }
    ).assets.find((a) => a.assetId === norris);
    expect(entry!.recentPoints).toEqual([100, 20, 5]);
    // The price going in is the one in force for round 3: 280 after round 1
    // (average 100, great, +3), then 283 after round 2 (average 60, great, +3).
    expect(entry).toMatchObject({
      price: 286,
      average: (100 + 20 + 5) / 3,
      tier: "great",
      newPrice: 289,
    });
  });

  const entryOf = async (runId: string, key: string) => {
    const [run] = await t.db
      .select()
      .from(priceUpdateRuns)
      .where(eq(priceUpdateRuns.id, runId));
    const assetId = await game.assetId(key);
    return (
      run!.inputs as {
        assets: { assetId: string; recentPoints: number[] }[];
      }
    ).assets.find((a) => a.assetId === assetId);
  };

  it("an asset absent from the scored event keeps its price", async () => {
    await score(rounds[0]!.id, {}, ["hadjar"]);
    const { runId } = (await update(rounds[0]!.id)) as { runId: string };

    const entry = await entryOf(runId, "hadjar");
    expect(entry).toMatchObject({
      recentPoints: [],
      average: null,
      ratio: null,
      tier: null,
      change: 0,
      absent: true,
    });
    const hadjar = await game.assetId("hadjar");
    expect((await pricesOf(rounds[1]!.id)).get(hadjar)).toBe(
      (await pricesOf(rounds[0]!.id)).get(hadjar),
    );
  });

  it("an event the asset missed isn't one of its last three", async () => {
    await score(rounds[0]!.id, { hadjar: 40 });
    expect(await update(rounds[0]!.id)).toHaveProperty("runId");
    await score(rounds[1]!.id, {}, ["hadjar"]);
    await lockOpenThrough(2);
    expect(await update(rounds[1]!.id)).toHaveProperty("runId");
    await score(rounds[2]!.id, { hadjar: 10 });
    await lockOpenThrough(3);
    const { runId } = (await update(rounds[2]!.id)) as { runId: string };

    expect((await entryOf(runId, "hadjar"))!.recentPoints).toEqual([40, 10]);
  });

  it("a driver with some lines of their own isn't absent", async () => {
    await score(rounds[0]!.id, { hadjar: 3 }, ["hadjar"]);
    const { runId } = (await update(rounds[0]!.id)) as { runId: string };

    const entry = await entryOf(runId, "hadjar");
    expect(entry!.recentPoints).toEqual([-17]);
    expect(entry).not.toHaveProperty("absent");
  });

  it("an open next event is skipped", async () => {
    await score(rounds[0]!.id, { norris: 40 });
    await lockOpenThrough(2);
    const before = await pricesOf(rounds[1]!.id);

    expect(await update(rounds[0]!.id)).toEqual({ skipped: "next_open" });
    expect(await pricesOf(rounds[1]!.id)).toEqual(before);
    expect(await t.db.select().from(priceUpdateRuns)).toEqual([]);
  });

  it("an event with no scores is skipped", async () => {
    expect(await update(rounds[0]!.id)).toEqual({ skipped: "no_scores" });
    expect((await pricesOf(rounds[1]!.id)).size).toBe(0);
    expect(await t.db.select().from(priceUpdateRuns)).toEqual([]);

    // A run that isn't current doesn't count as scored.
    await score(rounds[0]!.id, { norris: 40 });
    await t.db.update(scoringRuns).set({ isCurrent: false });
    expect(await update(rounds[0]!.id)).toEqual({ skipped: "no_scores" });
  });

  it("the last event has no next to price", async () => {
    const [last] = await t.db
      .select()
      .from(events)
      .orderBy(desc(events.lockAt))
      .limit(1);
    await score(last!.id, { norris: 40 });
    expect(await update(last!.id)).toEqual({ skipped: "no_next" });
  });

  it("a cancelled next event is passed over", async () => {
    await score(rounds[0]!.id, { norris: 40 });
    const cancelledAt = new Date(rounds[1]!.lockAt.getTime() - 3_600_000);
    await setSimulatedClock(t.db, cancelledAt);
    await t.db
      .update(events)
      .set({ status: "cancelled" })
      .where(eq(events.id, rounds[1]!.id));
    await planGameEvents(t.db, cancelledAt, gameId);

    expect(await update(rounds[0]!.id)).toHaveProperty("runId");
    expect((await pricesOf(rounds[2]!.id)).size).toBe(33);
    expect((await pricesOf(rounds[1]!.id)).size).toBe(0);
  });

  it("a withdrawn asset is still priced", async () => {
    const bottas = await game.assetId("bottas");
    await withdrawPoolAsset(t.db, NOW, {
      assetId: bottas,
      fromEventId: rounds[1]!.id,
      reason: "Out for the season",
      actor: { kind: "admin", label: "staff" },
    });
    await score(rounds[0]!.id, { bottas: 30 });
    const result = await update(rounds[0]!.id);

    expect(result).toHaveProperty("runId");
    // $3.6M expects 3.6 points: 30 is ratio 8.3, great, cheap +6.
    expect((await pricesOf(rounds[1]!.id)).get(bottas)).toBe(42);
  });

  it("a formula run keeps an admin price", async () => {
    const norris = await game.assetId("norris");
    await publishPrices(t.db, NOW, {
      gameId,
      eventId: rounds[1]!.id,
      source: "admin",
      reason: "Hand-set",
      actor: { kind: "admin", label: "staff" },
      prices: [{ assetId: norris, price: 300 }],
    });
    await score(rounds[0]!.id, { norris: 40, piastri: 14 });
    const { runId } = (await update(rounds[0]!.id)) as { runId: string };

    const [row] = await t.db
      .select()
      .from(assetPrices)
      .where(
        and(
          eq(assetPrices.eventId, rounds[1]!.id),
          eq(assetPrices.assetId, norris),
        ),
      );
    expect(row).toMatchObject({ price: 300, source: "admin", runId: null });
    // The rest of the list is the formula's, and the list is complete.
    const prices = await pricesOf(rounds[1]!.id);
    expect(prices.size).toBe(33);
    expect(prices.get(await game.assetId("piastri"))).toBe(249);

    const [run] = await t.db
      .select()
      .from(priceUpdateRuns)
      .where(eq(priceUpdateRuns.id, runId));
    const assets = (run!.inputs as { assets: Record<string, unknown>[] })
      .assets;
    expect(assets.find((a) => a.assetId === norris)).toMatchObject({
      kept: "admin",
      recentPoints: [40],
      tier: "great",
    });
    expect(assets.filter((a) => a.kept !== undefined)).toHaveLength(1);
  });

  it("running again replaces the run's prices without a second price", async () => {
    await score(rounds[0]!.id, { norris: 40 });
    const first = (await update(rounds[0]!.id)) as { runId: string };
    const second = (await update(rounds[0]!.id)) as { runId: string };
    expect(second.runId).not.toBe(first.runId);

    const rows = await t.db
      .select()
      .from(assetPrices)
      .where(eq(assetPrices.eventId, rounds[1]!.id));
    expect(rows).toHaveLength(33);
    expect(rows.every((r) => r.runId === second.runId)).toBe(true);
  });
});
