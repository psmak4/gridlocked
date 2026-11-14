import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  lockRound,
  round2026,
  seedGame2026,
} from "../../tests/helpers/game-2026";
import { idFor } from "../../tests/helpers/ingest-2026";
import { seededRandom } from "../../tests/helpers/random";
import { replayScores2026 } from "../../tests/helpers/replay-2026";
import { createTestDb } from "../../tests/helpers/test-db";
import { seedUser } from "../../tests/helpers/users";
import {
  assetPrices,
  games,
  lineupPicks,
  poolAssets,
  profiles,
  sessions,
  teamEventStates,
  teams,
} from "@/db/schema";
import type { Db } from "@/db/types";
import type { LineupPick } from "@/game/lineups";
import { openGame } from "@/game/lineups";
import { createTeam } from "@/game/teams";
import type { Viewer } from "@/identity/viewer";
import { newId } from "@/lib/ids";
import { setSimulatedClock } from "@/replay/clock-loop";
import { markWatched } from "@/spoilers/reveal";
import {
  builderState,
  poolAvailability,
  saveTeamAction,
  type BuilderState,
} from "./builder";
import { previewTeam } from "./preview";

const SEEDED = new Date("2026-02-01T09:00:00.000Z");
const MINUTE = 60_000;

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

async function viewerOf(db: Db, userId: string): Promise<Viewer> {
  const [profile] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.userId, userId));
  return {
    userId,
    role: "user",
    banned: false,
    username: null,
    displayUsername: null,
    emailVerified: true,
    twoFactorEnabled: false,
    sessionId: newId(),
    impersonatedBy: null,
    staffVerifiedAt: null,
    profile: profile!,
    complete: true,
  };
}

const unprotected = (userId: string) => ({
  userId,
  spoilerProtection: false,
});

/** A new user with a team in the game. */
async function newTeam(db: Db, now: Date, gameId: string) {
  const userId = await seedUser(db);
  const teamId = await createTeam(db, now, { gameId, userId, name: "Mine" });
  return { userId, teamId };
}

/** The cheapest full lineup in the pool, the Boost on its first driver. */
function cheapest(state: BuilderState): LineupPick[] {
  const byPrice = [...state.pool]
    .filter((row) => row.availability !== "withdrawn")
    .sort((a, b) => a.price - b.price);
  const drivers = byPrice
    .filter((row) => row.kind === "driver")
    .slice(0, state.squad.drivers);
  const constructors = byPrice
    .filter((row) => row.kind === "constructor")
    .slice(0, state.squad.constructors);
  return [
    ...drivers.map((row, i) => ({ assetId: row.assetId, isBoost: i === 0 })),
    ...constructors.map((row) => ({ assetId: row.assetId, isBoost: false })),
  ];
}

/** The lineup picks of a version. */
async function picksOf(db: Db, versionId: string): Promise<LineupPick[]> {
  return db
    .select({ assetId: lineupPicks.assetId, isBoost: lineupPicks.isBoost })
    .from(lineupPicks)
    .where(eq(lineupPicks.lineupVersionId, versionId));
}

const byAsset = (picks: LineupPick[]) =>
  [...picks].sort((a, b) => a.assetId.localeCompare(b.assetId));

describe("builderState before round 1's lock", () => {
  let t: TestDb;
  let db: Db;
  let gameId: string;
  let now: Date;

  beforeEach(async () => {
    t = await createTestDb();
    db = t.db as unknown as Db;
    ({ gameId } = await seedGame2026(db, SEEDED));
    await openGame(db, SEEDED, gameId);
    const round1 = await round2026(db, 1);
    now = new Date(round1.lockAt.getTime() - 60 * MINUTE);
    await setSimulatedClock(t.db, now);
  });

  afterEach(async () => {
    await t.close();
  });

  it("before round 1's lock: phase open, every pool asset priced, nothing in base, unlimited transfers", async () => {
    const { userId, teamId } = await newTeam(db, now, gameId);
    const state = await builderState(db, now, {
      teamId,
      reader: unprotected(userId),
    });
    const pool = await db
      .select({ id: poolAssets.id })
      .from(poolAssets)
      .where(eq(poolAssets.gameId, gameId));

    expect(state.phase).toBe("open");
    expect(state.event).toMatchObject({ round: 1 });
    expect(state.pool).toHaveLength(pool.length);
    expect(state.pool.every((row) => row.price > 0)).toBe(true);
    expect(state.pool.every((row) => !row.inBase)).toBe(true);
    // No event before round 1: no price change and no ownership yet.
    expect(state.pool.every((row) => row.delta === null)).toBe(true);
    expect(state.pool.every((row) => row.ownership === null)).toBe(true);
    expect(state).toMatchObject({
      base: null,
      latest: null,
      freeTransfers: null,
      purchasingPower: 1000,
      penaltyPerTransfer: -10,
      squad: { drivers: 5, constructors: 2, boosts: 1 },
      limitless: false,
      x3TargetAssetId: null,
      lateCallOpen: false,
    });
    const verstappen = state.pool.find((row) => row.code === "VER");
    expect(verstappen).toMatchObject({
      kind: "driver",
      title: "Max Verstappen",
      availability: "available",
    });
    expect(verstappen!.color).toMatch(/^#[0-9a-fA-F]{6}$/);
    // Every chip is there, and the after-first-race ones wait.
    expect(state.chips.map((c) => [c.name, c.status])).toEqual([
      ["Strategist", "available"],
      ["Overdrive", "available"],
      ["Safety Car", "available"],
      ["Rebuild", "locked_until_first_race"],
      ["Blank Cheque", "locked_until_first_race"],
      ["Late Call", "locked_until_first_race"],
    ]);
  });

  it("another user's team is team_not_owned", async () => {
    const { teamId } = await newTeam(db, now, gameId);
    const other = await seedUser(db);
    await expect(
      builderState(db, now, { teamId, reader: unprotected(other) }),
    ).rejects.toMatchObject({ code: "team_not_owned" });
    expect(
      await saveTeamAction(db, now, await viewerOf(db, other), {
        teamId,
        picks: [],
        basedOnVersionId: null,
      }),
    ).toEqual({ ok: false, error: "team_not_owned" });
  });

  it("a save returns staleBase when another save came first", async () => {
    const { userId, teamId } = await newTeam(db, now, gameId);
    const viewer = await viewerOf(db, userId);
    const state = await builderState(db, now, {
      teamId,
      reader: unprotected(userId),
    });
    const picks = cheapest(state);
    expect(previewTeam(state, picks).problems).toEqual([]);

    const first = await saveTeamAction(db, now, viewer, {
      teamId,
      picks,
      basedOnVersionId: null,
    });
    expect(first).toMatchObject({ ok: true, staleBase: false });
    // A second device, still editing the blank start.
    const second = await saveTeamAction(db, now, viewer, {
      teamId,
      picks,
      basedOnVersionId: null,
    });
    expect(second).toMatchObject({ ok: true, staleBase: true });

    const after = await builderState(db, now, {
      teamId,
      reader: unprotected(userId),
    });
    expect(after.latest?.versionId).toBe(
      (second as { versionId: string }).versionId,
    );
    expect(byAsset(after.latest!.picks)).toEqual(byAsset(picks));
  });

  it("a save after the lock is window_closed", async () => {
    const { userId, teamId } = await newTeam(db, now, gameId);
    const viewer = await viewerOf(db, userId);
    const state = await builderState(db, now, {
      teamId,
      reader: unprotected(userId),
    });
    const late = new Date(state.event!.lockAt);
    await setSimulatedClock(t.db, late);
    expect(
      await saveTeamAction(db, late, viewer, {
        teamId,
        picks: cheapest(state),
        basedOnVersionId: null,
      }),
    ).toEqual({ ok: false, error: "window_closed" });
    const locked = await builderState(db, late, {
      teamId,
      reader: unprotected(userId),
    });
    expect(locked.phase).toBe("locked");
  });

  it("Hadjar in rounds 12 to 14 is out", async () => {
    const hadjar = await idFor(db, "driver", "hadjar");
    const [asset] = await db
      .select({ id: poolAssets.id })
      .from(poolAssets)
      .where(
        and(eq(poolAssets.gameId, gameId), eq(poolAssets.driverId, hadjar)),
      );
    const seen: Record<number, string | undefined> = {};
    for (const round of [11, 12, 13, 14, 15]) {
      const { id } = await round2026(db, round);
      seen[round] = (await poolAvailability(db, { gameId, eventId: id })).get(
        asset!.id,
      );
    }
    expect(seen).toEqual({
      11: "available",
      12: "out",
      13: "out",
      14: "out",
      15: "available",
    });
  });
});

describe("builderState after round 1 is final", () => {
  let t: TestDb;
  let db: Db;
  let gameId: string;
  let now: Date;
  /** Twenty more teams, with random round 1 lineups, for the lock check. */
  const extra: Array<{ userId: string; teamId: string }> = [];

  beforeEach(async () => {
    t = await createTestDb();
    db = t.db as unknown as Db;
    extra.length = 0;
    const random = seededRandom(2026);
    await replayScores2026(t.db as never, {
      throughRound: 1,
      actions: [
        {
          at: "2026-03-06T00:00:00.000Z",
          run: async (at, ctx) => {
            for (let i = 0; i < 20; i++) {
              const made = await newTeam(db, at, ctx.gameId);
              extra.push(made);
              const state = await builderState(db, at, {
                teamId: made.teamId,
                reader: unprotected(made.userId),
              });
              const picks = randomLineup(state, random, null);
              const saved = await saveTeamAction(
                db,
                at,
                await viewerOf(db, made.userId),
                { teamId: made.teamId, picks, basedOnVersionId: null },
              );
              expect(saved).toMatchObject({ ok: true });
            }
          },
        },
      ],
    });
    [{ gameId }] = (await db.select({ gameId: games.id }).from(games)) as [
      { gameId: string },
    ];
    const { rows } = (await db.execute(
      sql`select (value ->> 'at') as at from settings where key = 'simulated_clock'`,
    )) as { rows: Array<{ at: string }> };
    now = new Date(rows[0]!.at);
  });

  afterEach(async () => {
    await t.close();
  });

  /** A script team that locked into round 1, and its owner. */
  async function lockedTeam() {
    const round1 = await round2026(db, 1);
    const [row] = await db
      .select({
        teamId: teams.id,
        userId: teams.userId,
        lockedVersionId: teamEventStates.lockedVersionId,
        bank: teamEventStates.bank,
      })
      .from(teamEventStates)
      .innerJoin(teams, eq(teams.id, teamEventStates.teamId))
      .where(eq(teamEventStates.eventId, round1.id))
      .orderBy(asc(teams.id))
      .limit(1);
    return row!;
  }

  it("after round 1 is final: round 2 open, base is round 1's locked lineup, purchasing power is the bank plus the base at round 2's prices", async () => {
    const team = await lockedTeam();
    const state = await builderState(db, now, {
      teamId: team.teamId,
      reader: unprotected(team.userId),
    });
    const round2 = await round2026(db, 2);
    const base = await picksOf(db, team.lockedVersionId);
    const prices = await db
      .select({ assetId: assetPrices.assetId, price: assetPrices.price })
      .from(assetPrices)
      .where(
        and(
          eq(assetPrices.eventId, round2.id),
          inArray(
            assetPrices.assetId,
            base.map((p) => p.assetId),
          ),
        ),
      );

    expect(state.phase).toBe("open");
    expect(state.event).toMatchObject({ id: round2.id, round: 2 });
    expect(byAsset(state.base!)).toEqual(byAsset(base));
    expect(state.purchasingPower).toBe(
      team.bank + prices.reduce((sum, p) => sum + p.price, 0),
    );
    // Round 1 was unlimited, which carries nothing: the 2 free.
    expect(state.freeTransfers).toBe(2);
    expect(
      state.pool
        .filter((row) => row.inBase)
        .map((row) => row.assetId)
        .sort(),
    ).toEqual(base.map((p) => p.assetId).sort());
    expect(state.chips.find((c) => c.name === "Rebuild")?.status).toBe(
      "available",
    );
  });

  it("a withdrawn driver shows as withdrawn, and only an owner sees him pickable", async () => {
    const team = await lockedTeam();
    const round2 = await round2026(db, 2);
    const owned = (await picksOf(db, team.lockedVersionId)).find(
      (p) => !p.isBoost,
    )!;
    await db
      .update(poolAssets)
      .set({ status: "withdrawn", withdrawnFromEventId: round2.id })
      .where(eq(poolAssets.id, owned.assetId));

    const owner = await builderState(db, now, {
      teamId: team.teamId,
      reader: unprotected(team.userId),
    });
    expect(
      owner.pool.find((row) => row.assetId === owned.assetId),
    ).toMatchObject({ availability: "withdrawn", inBase: true });
    expect(previewTeam(owner, owner.base!).problems).not.toContain(
      "unavailable",
    );

    const stranger = await newTeam(db, now, gameId);
    const theirs = await builderState(db, now, {
      teamId: stranger.teamId,
      reader: unprotected(stranger.userId),
    });
    expect(
      theirs.pool.find((row) => row.assetId === owned.assetId),
    ).toMatchObject({ availability: "withdrawn", inBase: false });
    expect(previewTeam(theirs, owner.base!).problems).toContain("unavailable");
  });

  it("ownership is the share of round 1's locked teams holding each asset", async () => {
    const team = await lockedTeam();
    const round1 = await round2026(db, 1);
    const locked = await db
      .select({ versionId: teamEventStates.lockedVersionId })
      .from(teamEventStates)
      .where(eq(teamEventStates.eventId, round1.id));
    const holders = new Map<string, number>();
    for (const { versionId } of locked) {
      for (const pick of await picksOf(db, versionId)) {
        holders.set(pick.assetId, (holders.get(pick.assetId) ?? 0) + 1);
      }
    }

    const state = await builderState(db, now, {
      teamId: team.teamId,
      reader: unprotected(team.userId),
    });
    for (const row of state.pool) {
      expect(row.ownership).toBeCloseTo(
        (holders.get(row.assetId) ?? 0) / locked.length,
      );
    }
  });

  it("the price delta is null while round 1's race is hidden for this viewer", async () => {
    const team = await lockedTeam();
    const protectedReader = { userId: team.userId, spoilerProtection: true };
    const hidden = await builderState(db, now, {
      teamId: team.teamId,
      reader: protectedReader,
    });
    expect(hidden.pool.every((row) => row.delta === null)).toBe(true);

    const round1 = await round2026(db, 1);
    const round2 = await round2026(db, 2);
    const priceAt = async (eventId: string) =>
      new Map(
        (
          await db
            .select({ assetId: assetPrices.assetId, price: assetPrices.price })
            .from(assetPrices)
            .where(eq(assetPrices.eventId, eventId))
        ).map((r) => [r.assetId, r.price]),
      );
    const [before, after] = [
      await priceAt(round1.id),
      await priceAt(round2.id),
    ];

    const shown = await builderState(db, now, {
      teamId: team.teamId,
      reader: unprotected(team.userId),
    });
    for (const row of shown.pool) {
      expect(row.delta).toBe(
        after.get(row.assetId)! - before.get(row.assetId)!,
      );
    }
    expect(shown.pool.some((row) => row.delta !== 0)).toBe(true);

    // Marking the race watched shows them too.
    const [race] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.eventId, round1.id), eq(sessions.kind, "race")));
    await markWatched(db, now, { userId: team.userId, sessionIds: [race!.id] });
    const watched = await builderState(db, now, {
      teamId: team.teamId,
      reader: protectedReader,
    });
    expect(watched.pool.map((row) => row.delta)).toEqual(
      shown.pool.map((row) => row.delta),
    );
  });

  it("preview agrees with the lock record", async () => {
    const random = seededRandom(7);
    const round2 = await round2026(db, 2);
    const previews = new Map<string, ReturnType<typeof previewTeam>>();
    for (const made of extra) {
      const state = await builderState(db, now, {
        teamId: made.teamId,
        reader: unprotected(made.userId),
      });
      const picks = randomLineup(state, random, state.base);
      const preview = previewTeam(state, picks);
      expect(preview.problems).toEqual([]);
      const saved = await saveTeamAction(
        db,
        now,
        await viewerOf(db, made.userId),
        { teamId: made.teamId, picks, basedOnVersionId: null },
      );
      expect(saved).toMatchObject({ ok: true });
      previews.set(made.teamId, preview);
    }

    await lockRound(t.db as never, gameId, round2.id);

    const rows = await db
      .select()
      .from(teamEventStates)
      .where(
        and(
          eq(teamEventStates.eventId, round2.id),
          inArray(teamEventStates.teamId, [...previews.keys()]),
        ),
      );
    expect(rows).toHaveLength(20);
    const seen = new Set<number>();
    for (const row of rows) {
      const preview = previews.get(row.teamId)!;
      expect({
        transfers: preview.transfers,
        free: preview.free,
        penalty: preview.penalty,
        spent: preview.spent,
      }).toEqual({
        transfers: row.transfersMade,
        free: row.freeTransfers,
        penalty: row.transferPenalty,
        spent: row.spent,
      });
      seen.add(row.transfersMade);
    }
    // The random lineups cover free transfers and paid ones.
    expect([...seen].some((n) => n <= 2)).toBe(true);
    expect([...seen].some((n) => n > 2)).toBe(true);
  });
});

/**
 * A random lineup the preview finds nothing wrong with: a fresh one, or
 * `base` with 0 to 5 assets swapped for others of their kind. The Boost goes
 * on a random driver.
 */
function randomLineup(
  state: BuilderState,
  random: () => number,
  base: LineupPick[] | null,
): LineupPick[] {
  const pickable = state.pool.filter(
    (row) => row.availability !== "withdrawn" || row.inBase,
  );
  const shuffle = <T>(items: T[]) =>
    items
      .map((item) => ({ item, key: random() }))
      .sort((a, b) => a.key - b.key)
      .map((x) => x.item);
  const kindOf = new Map(pickable.map((row) => [row.assetId, row.kind]));

  for (let attempt = 0; attempt < 500; attempt++) {
    let ids: string[];
    if (base) {
      const swaps = Math.floor(random() * 6);
      ids = base.map((p) => p.assetId);
      for (const i of shuffle([...ids.keys()]).slice(0, swaps)) {
        const kind = kindOf.get(ids[i]!);
        const replacement = shuffle(
          pickable.filter(
            (row) => row.kind === kind && !ids.includes(row.assetId),
          ),
        )[0];
        if (replacement) ids[i] = replacement.assetId;
      }
    } else {
      ids = [
        ...shuffle(pickable.filter((row) => row.kind === "driver"))
          .slice(0, state.squad.drivers)
          .map((row) => row.assetId),
        ...shuffle(pickable.filter((row) => row.kind === "constructor"))
          .slice(0, state.squad.constructors)
          .map((row) => row.assetId),
      ];
    }
    const drivers = ids.filter((id) => kindOf.get(id) === "driver");
    const boost = drivers[Math.floor(random() * drivers.length)];
    const picks = ids.map((assetId) => ({
      assetId,
      isBoost: assetId === boost,
    }));
    if (previewTeam(state, picks).problems.length === 0) return picks;
  }
  throw new Error("no affordable random lineup in 500 tries");
}
