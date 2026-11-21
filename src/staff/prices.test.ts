import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import { round2026, seedGame2026 } from "../../tests/helpers/game-2026";
import { sessionOf } from "../../tests/helpers/pipeline-2026";
import {
  assetPrices,
  assetScoreLines,
  auditLog,
  gameEvents,
  scoringRuns,
} from "@/db/schema";
import { openGame } from "@/game/lineups";
import { runPriceUpdate } from "@/game/price-formula";
import { newId } from "@/lib/ids";
import { setSimulatedClock } from "@/replay/clock-loop";
import type { StaffActor } from "./roster";
import { howItDid, nextPrices, setAdminPrice } from "./prices";

const NOW = new Date("2026-02-01T09:00:00.000Z");
const ACTOR: StaffActor = { kind: "admin", label: null, requestId: "r1" };

// The prices screen (M8 Task 9): the next event's list, each asset's inputs
// from the price update that wrote it, and a price set by hand while the
// event is still upcoming.
describe("nextPrices and setAdminPrice (M8 Task 9)", () => {
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
    for (const n of [1, 2]) rounds.push(await round2026(t.db, n));
    await openGame(t.db, NOW, gameId);
  });
  afterEach(async () => {
    await t.close();
  });

  /** Scores round 1's race with one stub line per named asset. */
  async function scoreRound1(points: Record<string, number>) {
    const race = await sessionOf(t.db, rounds[0]!.id, "race");
    const [ge] = await t.db
      .select()
      .from(gameEvents)
      .where(eq(gameEvents.eventId, rounds[0]!.id));
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
  }

  it("howItDid words the ratio in seven steps around the formula's thresholds", () => {
    const thresholds = { poor: 0.6, good: 0.9, great: 1.2 };
    expect(howItDid(null, thresholds)).toBeNull();
    expect(howItDid(0.5, thresholds)).toBe("Much worse");
    expect(howItDid(0.7, thresholds)).toBe("Worse");
    expect(howItDid(0.8, thresholds)).toBe("A bit worse");
    expect(howItDid(1.0, thresholds)).toBe("As expected");
    expect(howItDid(1.1, thresholds)).toBe("A bit better");
    expect(howItDid(1.3, thresholds)).toBe("Better");
    expect(howItDid(6.25, thresholds)).toBe("Much better");
  });

  it("nextPrices shows each asset's now, last-3 average, what its price expects, its tier and the change", async () => {
    // Before any update: round 2 has no prices, so nothing is published.
    const before = await nextPrices(t.db, gameId);
    expect(before).toMatchObject({
      event: { id: rounds[1]!.id, round: 2 },
      published: false,
      publishedAfter: null,
      previous: { round: 1 },
    });

    await scoreRound1({
      norris: 24, // 24 + 6 on $28M: ratio 1.07
      piastri: 14, // 14 + 6 on $25M: ratio 0.8
      cadillac: 10, // 10 + 15 on $4M: ratio 6.25
    });
    await runPriceUpdate(t.db, NOW, {
      gameId,
      afterEventId: rounds[0]!.id,
      ranBy: "system",
    });

    const after = await nextPrices(t.db, gameId);
    expect(after).toMatchObject({
      event: { id: rounds[1]!.id, round: 2 },
      published: true,
      publishedAfter: { id: rounds[0]!.id, round: 1 },
    });
    const row = (id: string) => after!.rows.find((r) => r.assetId === id);
    expect(row(await game.assetId("norris"))).toMatchObject({
      kind: "driver",
      name: "Lando Norris",
      now: 280,
      average: 24,
      expects: 22,
      word: "A bit better",
      change: 1,
      next: 281,
      source: "formula",
    });
    expect(row(await game.assetId("piastri"))).toMatchObject({
      now: 250,
      average: 14,
      expects: 19,
      word: "A bit worse",
      change: -1,
      next: 249,
    });
    expect(row(await game.assetId("cadillac"))).toMatchObject({
      kind: "constructor",
      now: 40,
      average: 10,
      expects: -11,
      word: "Much better",
      change: 6,
      next: 46,
    });
    expect(after!.counts.up + after!.counts.down + after!.counts.same).toBe(
      after!.rows.length,
    );
    expect(after!.counts.staff).toBe(0);
  });

  it("setAdminPrice on an upcoming event writes an admin price and audits asset_price.set", async () => {
    const norris = await game.assetId("norris");
    await setAdminPrice(t.db, NOW, ACTOR, {
      gameId,
      eventId: rounds[1]!.id,
      assetId: norris,
      price: 275,
      reason: "Grid penalty announced",
    });
    const [stored] = await t.db
      .select()
      .from(assetPrices)
      .where(
        and(
          eq(assetPrices.assetId, norris),
          eq(assetPrices.eventId, rounds[1]!.id),
        ),
      );
    expect(stored).toMatchObject({ price: 275, source: "admin" });
    const [entry] = await t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "asset_price.set"));
    expect(entry).toMatchObject({
      entityId: norris,
      reason: "Grid penalty announced",
      after: { eventId: rounds[1]!.id, price: 275, source: "admin" },
    });
    const view = await nextPrices(t.db, gameId);
    expect(view!.rows.find((r) => r.assetId === norris)).toMatchObject({
      next: 275,
      source: "admin",
    });
    expect(view!.counts.staff).toBe(1);
  });

  it("setAdminPrice on an open event is refused with prices_frozen", async () => {
    await expect(
      setAdminPrice(t.db, NOW, ACTOR, {
        gameId,
        eventId: rounds[0]!.id,
        assetId: await game.assetId("norris"),
        price: 275,
        reason: "Too late",
      }),
    ).rejects.toMatchObject({ code: "prices_frozen" });
  });

  it("setAdminPrice outside $3M–$34M is refused with invalid", async () => {
    for (const price of [29, 341, 27.5]) {
      await expect(
        setAdminPrice(t.db, NOW, ACTOR, {
          gameId,
          eventId: rounds[1]!.id,
          assetId: await game.assetId("norris"),
          price,
          reason: "Out of range",
        }),
      ).rejects.toMatchObject({ code: "invalid" });
    }
    expect(
      await t.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "asset_price.set")),
    ).toHaveLength(0);
  });
});
