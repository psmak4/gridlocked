import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { round2026 } from "../../tests/helpers/game-2026";
import { replayScores2026 } from "../../tests/helpers/replay-2026";
import { createTestDb } from "../../tests/helpers/test-db";
import { seedUser } from "../../tests/helpers/users";
import {
  assetPrices,
  games,
  lineupPicks,
  sessions,
  teamEventStates,
  teams,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { priceChange } from "@/game/price-formula";
import { RULESET_2026 } from "@/game/ruleset";
import { markWatched } from "@/spoilers/reveal";
import { teamValueWords } from "@/components/play/price-words";
import { howPricesWork, priceBoard } from "./prices";

// Prices (M6 Task 14) after the replayed round 1: round 2's prices are
// published, and the clock is inside round 1's 7-day spoiler window.

describe("the price board after round 1's update", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: Db;
  let gameId: string;
  let now: Date;
  /** Round 2's price minus round 1's, by asset. */
  const moved = new Map<string, number>();
  const round2Price = new Map<string, number>();

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db as unknown as Db;
    await replayScores2026(t.db as never, { throughRound: 1, actions: [] });
    [{ gameId }] = (await db.select({ gameId: games.id }).from(games)) as [
      { gameId: string },
    ];
    const { rows } = (await db.execute(
      sql`select (value ->> 'at') as at from settings where key = 'simulated_clock'`,
    )) as { rows: Array<{ at: string }> };
    now = new Date(rows[0]!.at);
    const priceAt = async (eventId: string) =>
      new Map(
        (
          await db
            .select({ assetId: assetPrices.assetId, price: assetPrices.price })
            .from(assetPrices)
            .where(eq(assetPrices.eventId, eventId))
        ).map((r) => [r.assetId, r.price]),
      );
    const before = await priceAt((await round2026(db, 1)).id);
    const after = await priceAt((await round2026(db, 2)).id);
    for (const [id, price] of after) {
      round2Price.set(id, price);
      moved.set(id, price - before.get(id)!);
    }
  }, 600_000);

  afterAll(async () => {
    await t.close();
  });

  const open = (userId: string) => ({ userId, spoilerProtection: false });

  it("after round 1's update, up and down match the run's changes", async () => {
    const userId = await seedUser(db);
    const board = await priceBoard(db, now, { gameId, reader: open(userId) });
    expect(board.event).toMatchObject({ round: 2 });
    expect(board.changesFrom).toMatchObject({ round: 1 });
    expect(board.changesHidden).toBe(false);
    expect(board.all).toHaveLength(round2Price.size);
    for (const row of board.all) {
      expect(row.price).toBe(round2Price.get(row.assetId));
      expect(row.change).toBe(moved.get(row.assetId));
    }
    const rising = [...moved].filter(([, c]) => c > 0).map(([id]) => id);
    const falling = [...moved].filter(([, c]) => c < 0).map(([id]) => id);
    expect(rising.length + falling.length).toBeGreaterThan(0);
    expect(board.up.map((r) => r.assetId).sort()).toEqual(rising.sort());
    expect(board.down.map((r) => r.assetId).sort()).toEqual(falling.sort());
    // The biggest moves first.
    for (const list of [board.up, board.down]) {
      const sizes = list.map((r) => Math.abs(r.change!));
      expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    }
  });

  it("Review Focus 3: a viewer who hasn't watched round 1's race gets no change figures", async () => {
    const userId = await seedUser(db);
    const reader = { userId, spoilerProtection: true };
    const hidden = await priceBoard(db, now, { gameId, reader });
    expect(hidden.changesHidden).toBe(true);
    expect(hidden.up).toEqual([]);
    expect(hidden.down).toEqual([]);
    expect(hidden.all.every((r) => r.change === null)).toBe(true);
    // Current prices always show.
    expect(hidden.all.map((r) => r.price)).toEqual(
      hidden.all.map((r) => round2Price.get(r.assetId)),
    );

    const [race] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        and(
          eq(sessions.eventId, (await round2026(db, 1)).id),
          eq(sessions.kind, "race"),
        ),
      );
    await markWatched(db, now, { userId, sessionIds: [race!.id] });
    const watched = await priceBoard(db, now, { gameId, reader });
    expect(watched.changesHidden).toBe(false);
    expect(watched.up.length + watched.down.length).toBeGreaterThan(0);
  });

  it("?show=changes gives them to a logged-out visitor", async () => {
    const covered = await priceBoard(db, now, { gameId, reader: null });
    expect(covered.changesHidden).toBe(true);
    expect(covered.all.every((r) => r.change === null)).toBe(true);
    expect(covered.teamValue).toBeNull();
    const shown = await priceBoard(db, now, {
      gameId,
      reader: null,
      show: "changes",
    });
    expect(shown.changesHidden).toBe(false);
    for (const row of shown.all) {
      expect(row.change).toBe(moved.get(row.assetId));
    }
  });

  it("team value is the base lineup at the current prices plus the bank", async () => {
    const round1 = await round2026(db, 1);
    const [team] = await db
      .select({
        teamId: teams.id,
        userId: teams.userId,
        name: teams.name,
        lockedVersionId: teamEventStates.lockedVersionId,
        bank: teamEventStates.bank,
      })
      .from(teamEventStates)
      .innerJoin(teams, eq(teams.id, teamEventStates.teamId))
      .where(eq(teamEventStates.eventId, round1.id))
      .orderBy(asc(teams.id))
      .limit(1);
    const picks = (
      await db
        .select({ assetId: lineupPicks.assetId })
        .from(lineupPicks)
        .where(eq(lineupPicks.lineupVersionId, team!.lockedVersionId!))
    ).map((p) => p.assetId);
    const board = await priceBoard(db, now, {
      gameId,
      reader: open(team!.userId),
      userId: team!.userId,
    });
    const value =
      picks.reduce((sum, id) => sum + round2Price.get(id)!, 0) + team!.bank;
    const change = picks.reduce((sum, id) => sum + moved.get(id)!, 0);
    expect(board.teamValue).toEqual({
      teamName: team!.name,
      now: value,
      change,
    });
    expect(
      board.all
        .filter((r) => r.yours)
        .map((r) => r.assetId)
        .sort(),
    ).toEqual([...picks].sort());
  });
});

describe("how prices work", () => {
  it("the worked example agrees with priceChange", () => {
    const how = howPricesWork(RULESET_2026);
    const { formula, min, max } = RULESET_2026.prices;
    const result = priceChange({
      price: how.example.from,
      assetType: "driver",
      recentPoints: [44, 28, 21],
      formula,
      bounds: { min, max },
    });
    expect(how.example.to).toBe(result.newPrice);
    expect(how.example.change).toBe(result.newPrice - how.example.from);
    expect(how.example.label).toBe("Example numbers");
    expect(how.example.steps).toHaveLength(4);
    const sign = result.change >= 0 ? "+" : "−";
    expect(how.example.steps[2]!.value).toBe(
      `${sign}$${(Math.abs(result.change) / 10).toFixed(1)}M`,
    );
  });

  it("the steps read the version's thresholds, not constants in the page", () => {
    const params = structuredClone(RULESET_2026);
    params.prices.formula.window = 4;
    params.prices.formula.thresholds = { poor: 0.5, good: 0.8, great: 1.3 };
    params.prices.min = 40;
    params.prices.max = 300;
    const how = howPricesWork(params);
    const text = [
      ...how.rules,
      ...how.example.steps.map((s) => s.title + s.text),
    ].join(" ");
    expect(text).toContain("last 4 race weekends");
    expect(text).toContain("Average the last 4 races");
    expect(text).toContain("Under 50%");
    expect(text).toContain("130% or more");
    expect(text).toContain("between $4M and $30M");
    expect(text).not.toContain("60%");
  });

  it("team value in words", () => {
    expect(teamValueWords(10)).toBe("Up $1.0M since last race.");
    expect(teamValueWords(-3)).toBe("Down $0.3M since last race.");
    expect(teamValueWords(0)).toBe("No change since last race.");
    expect(teamValueWords(null)).toBeNull();
  });
});
