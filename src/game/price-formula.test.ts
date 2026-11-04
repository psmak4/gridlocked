import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
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
import { priceList } from "./prices";
import { withdrawPoolAsset } from "./pool";
import { RULESET_2026 } from "./ruleset";

// The price formula (DM 3.5): the pure step, then the update over the recorded
// 2026 game, whose scores here are hand-written lines on a stub run.

const NOW = new Date("2026-02-01T09:00:00.000Z");
const { formula } = RULESET_2026.prices;
const { min, max } = RULESET_2026.prices;

/** A price, the points that tier it, and what the band does with them. */
const change = (
  price: number,
  average: number,
  assetType: "driver" | "constructor" = "driver",
) => priceChange({ price, assetType, recentPoints: [average], formula });

describe("priceChange (pure)", () => {
  it("each tier maps to its change in each band", () => {
    // Expensive: $20M expects 20 points. Ratios 0.25, 0.75, 1.25 and 2.
    expect([5, 15, 25, 40].map((avg) => change(200, avg))).toEqual([
      { tier: "terrible", change: -3, newPrice: 197 },
      { tier: "poor", change: -1, newPrice: 199 },
      { tier: "good", change: 1, newPrice: 201 },
      { tier: "great", change: 3, newPrice: 203 },
    ]);
    // Cheap: $10M expects 10 points. Ratios 0.3, 0.8, 1.2 and 2.
    expect([3, 8, 12, 20].map((avg) => change(100, avg))).toEqual([
      { tier: "terrible", change: -6, newPrice: 94 },
      { tier: "poor", change: -2, newPrice: 98 },
      { tier: "good", change: 2, newPrice: 102 },
      { tier: "great", change: 6, newPrice: 106 },
    ]);
  });

  it("a ratio on a threshold takes the higher tier", () => {
    // $10M expects 10 points: ratios 0.6, 1 and 1.5 exactly.
    expect([6, 10, 15].map((avg) => change(100, avg).tier)).toEqual([
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
      ...formula,
      pointsPerMillion: { driver: 1, constructor: 2 },
    };
    // 20 points on $10M: a driver's baseline is 10, a constructor's 20.
    const base = { price: 100, recentPoints: [20], formula: own };
    expect(priceChange({ ...base, assetType: "driver" }).tier).toBe("great");
    expect(priceChange({ ...base, assetType: "constructor" }).tier).toBe(
      "good",
    );
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

  it("fewer than three events average what there is", () => {
    const run = (recentPoints: number[]) =>
      priceChange({ price: 100, assetType: "driver", recentPoints, formula });
    // Averages of 12 in each case: ratio 1.2, good.
    expect(run([12])).toEqual(run([12, 12, 12]));
    expect(run([10, 14])).toEqual(run([12, 12, 12]));
    expect(run([12]).tier).toBe("good");
  });

  it("only the newest three events count, the last ones in the list", () => {
    const run = (recentPoints: number[]) =>
      priceChange({ price: 100, assetType: "driver", recentPoints, formula });
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
        formula,
      }).tier,
    ).toBe("terrible");
  });

  it("with no recent events the price stays and there is no tier", () => {
    expect(
      priceChange({
        price: 123,
        assetType: "driver",
        recentPoints: [],
        formula,
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
  const score = async (eventId: string, points: Record<string, number>) => {
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
      norris: 40, // $28M expects 28: ratio 1.43, good
      piastri: 20, // $25M expects 25: ratio 0.8, poor
      cadillac: 10, // $4M expects 4: ratio 2.5, great
    });

    const result = await update(rounds[0]!.id);
    expect(result).toEqual({ runId: expect.any(String) });

    const prices = await pricesOf(rounds[1]!.id);
    expect(prices.size).toBe(33);
    expect(prices.get(await game.assetId("norris"))).toBe(281);
    expect(prices.get(await game.assetId("piastri"))).toBe(249);
    expect(prices.get(await game.assetId("cadillac"))).toBe(46);
    // No line means 0 points: terrible. Expensive -3, cheap -6.
    expect(prices.get(await game.assetId("leclerc"))).toBe(197);
    expect(prices.get(await game.assetId("haas"))).toBe(84);

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
    await score(rounds[0]!.id, { norris: 40, cadillac: 10 });
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
      recentPoints: [40],
      average: 40,
      ratio: 40 / 28,
      tier: "good",
      change: 1,
      newPrice: 281,
    });
    expect(byAsset.get(await game.assetId("haas"))).toMatchObject({
      assetType: "constructor",
      recentPoints: [0],
      average: 0,
      ratio: 0,
      tier: "terrible",
      change: -6,
      newPrice: 84,
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
      tier: "good",
      newPrice: 287,
    });
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
