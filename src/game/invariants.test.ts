import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { TransactionRollbackError } from "drizzle-orm/errors";
import { createTestDb } from "../../tests/helpers/test-db";
import {
  lockRound,
  openRound,
  round2026,
  seedGame2026,
} from "../../tests/helpers/game-2026";
import {
  chipPlays,
  lineupPicks,
  lineupVersions,
  sessionResultState,
  sessions,
  teamEventStates,
} from "@/db/schema";
import { newId } from "@/lib/ids";
import { setSimulatedClock } from "@/replay/clock-loop";
import { playChip, saveFinalFix } from "./chips";
import { checkGameInvariants } from "./invariants";
import { openGame, saveLineup, type LineupPick } from "./lineups";
import { createTeam } from "./teams";

// The season replay's invariants (Task 9), each shown to catch a hand-broken
// row. One small game is built once: two teams over rounds 1 and 2 of the
// recorded 2026 game, "Plain" with one transfer at round 2 and "Chips" with
// the x3 Boost at round 1 and Late Call at round 2. Each case writes its bad
// row in a transaction, checks, and rolls back, so the triggers that would
// refuse the row at commit never run, an index it drops comes back, and the
// next case starts from the clean game.

const NOW = new Date("2026-02-01T09:00:00.000Z");
const HOUR_MS = 3_600_000;
// 280 + 250 + 95 + 85 + 80 + 90 + 70 = 950, leaving 50 in the bank.
const LINEUP = ["norris", "piastri", "hulkenberg", "hadjar", "bearman"];
const CONSTRUCTORS = ["haas", "audi"];

type TestDb = Awaited<ReturnType<typeof createTestDb>>;
/** A transaction on the test database (it can set the simulated clock). */
type Tx = Parameters<Parameters<TestDb["db"]["transaction"]>[0]>[0];

describe("checkGameInvariants", () => {
  let t: TestDb;
  let game: Awaited<ReturnType<typeof seedGame2026>>;
  let gameId: string;
  let round1: { id: string; lockAt: Date };
  let round2: { id: string; lockAt: Date };
  let round3: { id: string; lockAt: Date };
  let plain: string;
  let chips: string;
  let lateCall: { versionId: string; chipPlayId: string };

  /**
   * Pool asset ids by Jolpica key, read once: `game.assetId` reads through the
   * test's own connection, which waits on a transaction that is open.
   */
  const ids = new Map<string, string>();
  const asset = (key: string) => {
    const id = ids.get(key);
    if (!id) throw new Error(`no asset ${key} read`);
    return id;
  };
  const picksOf = (drivers: string[]): LineupPick[] => [
    ...drivers.map((key) => ({
      assetId: asset(key),
      isBoost: key === drivers[0],
    })),
    ...CONSTRUCTORS.map((key) => ({ assetId: asset(key), isBoost: false })),
  ];
  const at = async (time: Date) => {
    await setSimulatedClock(t.db, time);
    return time;
  };
  const anHourBefore = (event: { lockAt: Date }) =>
    at(new Date(event.lockAt.getTime() - HOUR_MS));

  beforeAll(async () => {
    t = await createTestDb();
    game = await seedGame2026(t.db, NOW);
    gameId = game.gameId;
    await at(NOW);
    round1 = await round2026(t.db, 1);
    round2 = await round2026(t.db, 2);
    round3 = await round2026(t.db, 3);
    for (const key of [
      ...LINEUP,
      ...CONSTRUCTORS,
      "lawson",
      "alonso",
      "mclaren",
    ]) {
      ids.set(key, await game.assetId(key));
    }
    await openGame(t.db, NOW, gameId);
    plain = await createTeam(t.db, NOW, {
      gameId,
      userId: newId(),
      name: "Plain",
    });
    chips = await createTeam(t.db, NOW, {
      gameId,
      userId: newId(),
      name: "Chips",
    });

    const before1 = await anHourBefore(round1);
    for (const teamId of [plain, chips]) {
      await saveLineup(t.db, before1, {
        teamId,
        picks: picksOf(LINEUP),
        basedOnVersionId: null,
      });
    }
    await playChip(t.db, before1, {
      teamId: chips,
      chipCode: "chip_triple_boost",
      targetAssetId: asset("piastri"),
    });
    const locked = await lockRound(t.db, gameId, round1.id);
    await openRound(
      t.db,
      await at(new Date(locked.getTime() + HOUR_MS)),
      gameId,
      round2.id,
    );
    await saveLineup(t.db, await anHourBefore(round2), {
      teamId: plain,
      picks: picksOf(["norris", "piastri", "hulkenberg", "hadjar", "lawson"]),
      basedOnVersionId: null,
    });
    await lockRound(t.db, gameId, round2.id);

    const weekend = await t.db
      .select()
      .from(sessions)
      .where(eq(sessions.eventId, round2.id));
    const qualifying = weekend.find((s) => s.kind === "qualifying")!;
    const race = weekend.find((s) => s.kind === "race")!;
    await t.db
      .insert(sessionResultState)
      .values({ sessionId: qualifying.id, status: "provisional" });
    lateCall = await saveFinalFix(
      t.db,
      await at(new Date(race.scheduledStart.getTime() - 2 * HOUR_MS)),
      {
        teamId: chips,
        outAssetId: asset("hulkenberg"),
        inAssetId: asset("alonso"),
      },
    );
  }, 30_000);
  afterAll(async () => {
    await t?.close();
  });

  /** The violations with `write` done, in a transaction that is rolled back. */
  async function violationsWith(write: (tx: Tx) => Promise<unknown>) {
    let found: string[] | undefined;
    await t.db
      .transaction(async (tx) => {
        await write(tx);
        found = await checkGameInvariants(tx, gameId);
        tx.rollback();
      })
      .catch((error: unknown) => {
        if (!(error instanceof TransactionRollbackError)) throw error;
      });
    return found!;
  }
  const state = (teamId: string, eventId: string) =>
    and(
      eq(teamEventStates.teamId, teamId),
      eq(teamEventStates.eventId, eventId),
    );
  const dropIndex = (tx: Tx, name: string) =>
    tx.execute(sql.raw(`drop index "${name}"`));
  const insertPlay = (
    tx: Tx,
    teamId: string,
    eventId: string,
    chipCode: string,
    target?: string,
  ) =>
    tx.insert(chipPlays).values({
      id: newId(),
      teamId,
      gameId,
      chipCode,
      eventId,
      targetAssetId: target === undefined ? null : asset(target),
      status: "played",
    });

  it("the clean game has no violations", async () => {
    expect(await checkGameInvariants(t.db, gameId)).toEqual([]);
  });

  describe("each invariant reports a hand-broken state row", () => {
    it("a lock record that differs from its recompute", async () => {
      const found = await violationsWith((tx) =>
        tx
          .update(teamEventStates)
          .set({ transfersMade: 0 })
          .where(state(plain, round2.id)),
      );
      expect(found).toEqual([
        'team "Plain" round 2: transfers_made is 0, recomputed 1',
      ]);
    });

    it("a counted version saved at the lock", async () => {
      const found = await violationsWith(async (tx) => {
        // saved_at is the database's clock: the lock instant itself.
        await setSimulatedClock(tx, round2.lockAt);
        const id = newId();
        await tx.insert(lineupVersions).values({
          id,
          teamId: plain,
          forEventId: round2.id,
          kind: "regular",
          basedOnVersionId: null,
        });
        await tx
          .insert(lineupPicks)
          .values(picksOf(LINEUP).map((p) => ({ lineupVersionId: id, ...p })));
        await tx
          .update(teamEventStates)
          .set({ lockedVersionId: id })
          .where(state(plain, round2.id));
      });
      expect(found).toContainEqual(
        expect.stringMatching(
          /^team "Plain" round 2: the counted version .* was saved at .*, not before the lock/,
        ),
      );
    });

    it("a carry-over above 1", async () => {
      const found = await violationsWith((tx) =>
        tx
          .update(teamEventStates)
          .set({ carryOverOut: 2 })
          .where(state(plain, round2.id)),
      );
      expect(found).toContainEqual(
        'team "Plain" round 2: carry-over 2 is above 1',
      );
    });

    it("a penalty that isn't transferPenalty", async () => {
      const found = await violationsWith((tx) =>
        tx
          .update(teamEventStates)
          .set({ transferPenalty: -10 })
          .where(state(plain, round2.id)),
      );
      expect(found).toContainEqual(
        'team "Plain" round 2: transfer penalty -10, but transferPenalty gives 0',
      );
    });

    it("a negative bank outside Limitless", async () => {
      const found = await violationsWith((tx) =>
        tx
          .update(teamEventStates)
          .set({ bank: -5 })
          .where(state(plain, round2.id)),
      );
      expect(found).toContainEqual(
        'team "Plain" round 2: bank -5 is below 0 outside Limitless',
      );
    });

    it("a chip played twice in a season", async () => {
      const found = await violationsWith(async (tx) => {
        await dropIndex(tx, "chip_plays_team_id_chip_code_played_unique");
        await insertPlay(tx, chips, round3.id, "chip_triple_boost", "piastri");
      });
      expect(found).toEqual([
        'team "Chips": chip_triple_boost is played 2 times',
      ]);
    });

    it("two chips played for one event", async () => {
      const found = await violationsWith(async (tx) => {
        await dropIndex(tx, "chip_plays_team_id_event_id_played_unique");
        await insertPlay(tx, chips, round1.id, "chip_autopilot");
      });
      expect(found).toContainEqual(
        'team "Chips" round 1: 2 chips are played for the event',
      );
    });

    it("a chip played before it unlocks", async () => {
      const found = await violationsWith((tx) =>
        insertPlay(tx, plain, round1.id, "chip_wildcard"),
      );
      expect(found).toContainEqual(
        'team "Plain" round 1: chip_wildcard unlocks after the team\'s first event (round 1)',
      );
    });

    it("the x3 Boost on the 2x Boost driver", async () => {
      const found = await violationsWith((tx) =>
        insertPlay(tx, plain, round2.id, "chip_triple_boost", "norris"),
      );
      expect(found).toContainEqual(
        expect.stringMatching(
          /^team "Plain" round 2: the x3 Boost target .* is not a driver without the 2x Boost in the locked lineup$/,
        ),
      );
    });

    it("a Late Call that isn't one same-type swap", async () => {
      const swap = (from: string, to: string) => (tx: Tx) =>
        tx
          .update(lineupPicks)
          .set({ assetId: asset(to) })
          .where(
            and(
              eq(lineupPicks.lineupVersionId, lateCall.versionId),
              eq(lineupPicks.assetId, asset(from)),
            ),
          );
      // A second asset swapped as well.
      expect(await violationsWith(swap("bearman", "lawson"))).toEqual([
        expect.stringMatching(
          /^team "Chips" round 2: the Late Call version .* swaps 2 assets, not 1$/,
        ),
      ]);
      // Hülkenberg out for a constructor.
      expect(await violationsWith(swap("alonso", "mclaren"))).toEqual([
        expect.stringMatching(
          /^team "Chips" round 2: the Late Call version .* swaps a driver for a constructor$/,
        ),
      ]);
    });

    it("a Late Call outside its window", async () => {
      // As if qualifying's results never came in.
      const found = await violationsWith((tx) =>
        tx.update(sessionResultState).set({ status: "awaiting" }),
      );
      expect(found).toEqual([
        expect.stringMatching(
          /^team "Chips" round 2: the Late Call version .* was saved at .*, outside its window$/,
        ),
      ]);
    });
  });
});
