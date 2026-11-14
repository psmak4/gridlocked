import { and, eq, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedLeagueGames } from "../../tests/helpers/leagues-game";
import { errorCode } from "../../tests/helpers/staff";
import { createTestDb } from "../../tests/helpers/test-db";
import { seedUser } from "../../tests/helpers/users";
import {
  games,
  leagueMemberships,
  leagues,
  poolAssets,
  profiles,
  teams,
} from "@/db/schema";
import type { Db } from "@/db/types";
import type { Viewer } from "@/identity/viewer";
import { newId } from "@/lib/ids";
import {
  createTeamAction,
  myTeams,
  removeTeamAction,
  renameTeamAction,
} from "./teams";

const NOW = new Date("2026-02-01T09:00:00.000Z");

describe("teams (M6 Task 6)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: Db;
  let seeded: Awaited<ReturnType<typeof seedLeagueGames>>;

  beforeEach(async () => {
    t = await createTestDb();
    db = t.db as unknown as Db;
    seeded = await seedLeagueGames(db, NOW);
  });

  afterEach(async () => {
    await t.close();
  });

  async function viewerOf(
    userId: string,
    over: Partial<Viewer> = {},
  ): Promise<Viewer> {
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
      ...over,
    };
  }

  const teamOf = async (userId: string, slot: number) =>
    (
      await db
        .select()
        .from(teams)
        .where(
          and(
            eq(teams.gameId, seeded.gameId),
            eq(teams.userId, userId),
            eq(teams.slot, slot),
          ),
        )
    )[0];

  it("a new team joins its auto leagues straight away, in an open game", async () => {
    const userId = await seedUser(db);
    const [inPool] = seeded.constructorIds;
    await db.insert(poolAssets).values({
      id: newId(),
      gameId: seeded.gameId,
      assetType: "constructor",
      constructorId: inPool!,
      status: "active",
      addedFromEventId: seeded.eventIds[0]!,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await db
      .update(profiles)
      .set({ favoriteConstructorId: inPool!, countryCode: "GB" })
      .where(eq(profiles.userId, userId));

    expect(
      await createTeamAction(db, NOW, await viewerOf(userId), {
        name: "  Box Box  ",
      }),
    ).toEqual({ ok: true, slot: 1 });

    const team = await teamOf(userId, 1);
    expect(team).toMatchObject({ name: "Box Box", status: "active" });
    const joined = await db
      .select({ kind: leagues.kind, gameId: leagues.gameId })
      .from(leagueMemberships)
      .innerJoin(leagues, eq(leagues.id, leagueMemberships.leagueId))
      .where(
        and(
          eq(leagueMemberships.teamId, team!.id),
          isNull(leagueMemberships.leftAt),
        ),
      );
    expect(joined.map((l) => l.kind).sort()).toEqual([
      "auto_constructor",
      "auto_country",
    ]);
    expect(joined.every((l) => l.gameId === seeded.gameId)).toBe(true);
  });

  it("a fourth team is refused with no_free_slot", async () => {
    const viewer = await viewerOf(await seedUser(db));
    for (const slot of [1, 2, 3]) {
      expect(
        await createTeamAction(db, NOW, viewer, { name: `Team ${slot}` }),
      ).toEqual({ ok: true, slot });
    }
    expect(await createTeamAction(db, NOW, viewer, { name: "Team 4" })).toEqual(
      { ok: false, error: "no_free_slot" },
    );
    expect(
      (await myTeams(db, { gameId: seeded.gameId, userId: viewer.userId })).map(
        (team) => team.slot,
      ),
    ).toEqual([1, 2, 3]);
  });

  it("a name of 31 characters is bad_name", async () => {
    const viewer = await viewerOf(await seedUser(db));
    expect(
      await createTeamAction(db, NOW, viewer, { name: "x".repeat(31) }),
    ).toEqual({ ok: false, error: "bad_name" });
    expect(
      await createTeamAction(db, NOW, viewer, { name: "x".repeat(30) }),
    ).toEqual({ ok: true, slot: 1 });
    const { id } = (await teamOf(viewer.userId, 1))!;
    expect(
      await renameTeamAction(db, NOW, viewer, { teamId: id, name: "   " }),
    ).toEqual({ ok: false, error: "bad_name" });
  });

  it("removing a team before its first lock deletes it; after, retires it", async () => {
    const viewer = await viewerOf(await seedUser(db));
    await createTeamAction(db, NOW, viewer, { name: "Early" });
    await createTeamAction(db, NOW, viewer, { name: "Locked" });
    const early = (await teamOf(viewer.userId, 1))!;
    const locked = (await teamOf(viewer.userId, 2))!;
    await db
      .update(teams)
      .set({ firstEventId: seeded.eventIds[0]! })
      .where(eq(teams.id, locked.id));

    expect(
      await removeTeamAction(db, NOW, viewer, { teamId: early.id }),
    ).toEqual({ ok: true, removed: "deleted" });
    expect(
      await removeTeamAction(db, NOW, viewer, { teamId: locked.id }),
    ).toEqual({ ok: true, removed: "retired" });

    expect(
      await myTeams(db, { gameId: seeded.gameId, userId: viewer.userId }),
    ).toEqual([
      {
        id: locked.id,
        slot: 2,
        name: "Locked",
        status: "retired",
        locked: true,
      },
    ]);
    // A retired team keeps its name.
    expect(
      await renameTeamAction(db, NOW, viewer, {
        teamId: locked.id,
        name: "New",
      }),
    ).toEqual({ ok: false, error: "team_retired" });
  });

  it("someone else's team can't be renamed", async () => {
    const owner = await viewerOf(await seedUser(db));
    const other = await viewerOf(await seedUser(db));
    await createTeamAction(db, NOW, owner, { name: "Mine" });
    const { id } = (await teamOf(owner.userId, 1))!;

    expect(
      await renameTeamAction(db, NOW, other, { teamId: id, name: "Theirs" }),
    ).toEqual({ ok: false, error: "team_not_owned" });
    expect(await removeTeamAction(db, NOW, other, { teamId: id })).toEqual({
      ok: false,
      error: "team_not_owned",
    });
    expect(
      await renameTeamAction(db, NOW, other, { teamId: newId(), name: "X" }),
    ).toEqual({ ok: false, error: "team_not_owned" });
    expect((await teamOf(owner.userId, 1))!.name).toBe("Mine");

    expect(
      await renameTeamAction(db, NOW, owner, { teamId: id, name: "Renamed" }),
    ).toEqual({ ok: true });
    expect((await teamOf(owner.userId, 1))!.name).toBe("Renamed");
  });

  it("an impersonated session can't create a team", async () => {
    const userId = await seedUser(db);
    const admin = await seedUser(db, { role: "admin" });
    const viewer = await viewerOf(userId, { impersonatedBy: admin });

    expect(
      await errorCode(() =>
        createTeamAction(db, NOW, viewer, { name: "Not mine" }),
      ),
    ).toBe("read_only");
    expect(
      await errorCode(() =>
        createTeamAction(db, NOW, null, { name: "Nobody" }),
      ),
    ).toBe("unauthenticated");
    expect(await myTeams(db, { gameId: seeded.gameId, userId })).toEqual([]);
  });

  it("with no open game, a team can't be created", async () => {
    await db.update(games).set({ status: "setup" });
    const viewer = await viewerOf(await seedUser(db));
    expect(await createTeamAction(db, NOW, viewer, { name: "Early" })).toEqual({
      ok: false,
      error: "game_not_open",
    });
  });
});
