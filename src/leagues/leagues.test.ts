import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import { seedLeagueGames } from "../../tests/helpers/leagues-game";
import {
  constructors,
  leagueMemberships,
  leagues,
  LEAGUE_CAP,
  teams,
} from "@/db/schema";
import { GameError } from "@/game/errors";
import { createTeam, removeTeam } from "@/game/teams";
import { newId } from "@/lib/ids";
import {
  createLeague,
  joinLeague,
  leaveLeague,
  newJoinCode,
  syncAutoLeagues,
} from "./leagues";

// Leagues and their members over the recorded 2026 game: joining by code, the
// cap, and the auto leagues that follow a profile.

const NOW = new Date("2026-02-01T09:00:00.000Z");
const LATER = new Date("2026-02-01T10:00:00.000Z");
const LATEST = new Date("2026-02-01T11:00:00.000Z");

describe("leagues (DM 4.5, 4.6)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let seeded: Awaited<ReturnType<typeof seedLeagueGames>>;
  let gameId: string;
  let otherGameId: string;
  let userA: string;
  let userB: string;
  let teamA: string;
  let teamB: string;

  beforeEach(async () => {
    t = await createTestDb();
    seeded = await seedLeagueGames(t.db, NOW);
    ({ gameId, otherGameId } = seeded);
    userA = newId();
    userB = newId();
    teamA = await team(userA);
    teamB = await team(userB);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await t.close();
  });

  const team = (userId: string, game = gameId) =>
    createTeam(t.db, NOW, { gameId: game, userId, name: "Team" });
  const privateLeague = (name = "Friends", ownerUserId = userA) =>
    createLeague(t.db, NOW, {
      gameId,
      ownerUserId,
      kind: "private",
      name,
    });
  const memberships = (teamId: string) =>
    t.db
      .select()
      .from(leagueMemberships)
      .where(eq(leagueMemberships.teamId, teamId))
      .orderBy(asc(leagueMemberships.joinedAt), asc(leagueMemberships.id));
  /** A team that has locked is retired, not deleted. */
  const retire = async (teamId: string) => {
    await t.db
      .update(teams)
      .set({ firstEventId: seeded.eventIds[0]! })
      .where(eq(teams.id, teamId));
    expect(await removeTeam(t.db, LATER, teamId)).toBe("retired");
  };
  /** The leagues a team is in now, by name. */
  const currentLeagues = async (teamId: string) =>
    (
      await t.db
        .select({ name: leagues.name, left: leagueMemberships.leftAt })
        .from(leagueMemberships)
        .innerJoin(leagues, eq(leagues.id, leagueMemberships.leagueId))
        .where(eq(leagueMemberships.teamId, teamId))
    )
      .filter((row) => row.left === null)
      .map((row) => row.name)
      .sort();
  async function expectGameError(promise: Promise<unknown>, code: string) {
    const error = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error, "expected a GameError").toBeInstanceOf(GameError);
    expect((error as GameError).code).toBe(code);
  }
  /** The SQLSTATE is on the error or its cause. */
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

  it("a game has one global league, with no code and no members", async () => {
    const rows = await t.db
      .select()
      .from(leagues)
      .where(and(eq(leagues.gameId, gameId), eq(leagues.kind, "global")));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      slug: "global",
      joinCode: null,
      ownerUserId: null,
      startSequence: 1,
      endSequence: null,
      status: "active",
    });
    // The other game has its own.
    const other = await t.db
      .select()
      .from(leagues)
      .where(eq(leagues.gameId, otherGameId));
    expect(other.map((l) => l.kind)).toEqual(["global"]);
    // Nobody is put in it by hand.
    await expect(
      t.db.insert(leagueMemberships).values({
        id: newId(),
        leagueId: rows[0]!.id,
        teamId: teamA,
        joinedAt: NOW,
        source: "auto",
      }),
    ).rejects.toThrow();
  });

  it("a private league is joined by code, and a wrong code is league_not_found", async () => {
    const { leagueId, joinCode } = await privateLeague();
    expect(joinCode).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{10}$/);

    await expectGameError(
      joinLeague(t.db, LATER, {
        joinCode: "ABCDEFGHJK",
        teamId: teamB,
        userId: userB,
      }),
      "league_not_found",
    );
    expect(await memberships(teamB)).toHaveLength(0);

    // Case and spaces around a code typed by hand don't matter.
    const joined = await joinLeague(t.db, LATER, {
      joinCode: ` ${joinCode.toLowerCase()} `,
      teamId: teamB,
      userId: userB,
    });
    expect(joined.leagueId).toBe(leagueId);
    expect(await memberships(teamB)).toMatchObject([
      { leagueId, joinedAt: LATER, leftAt: null, source: "user" },
    ]);
  });

  it("join codes never use a look-alike and are spread over the alphabet", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const code = newJoinCode();
      expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{10}$/);
      for (const c of code) seen.add(c);
    }
    expect(seen.size).toBe(31);
  });

  it("a code or slug that collides is retried with new random parts", async () => {
    // The first league draws all zeros twice (code, then slug suffix), and so
    // does the second: the same code and slug. Its second try is random.
    const spy = vi.spyOn(crypto, "getRandomValues");
    for (let i = 0; i < 4; i++) {
      spy.mockImplementationOnce(((bytes: Uint8Array) =>
        bytes.fill(0)) as never);
    }
    const first = await privateLeague("Friends");
    const second = await privateLeague("Friends");
    expect(first.joinCode).toBe("AAAAAAAAAA");
    expect(second.joinCode).not.toBe(first.joinCode);
    expect(second.joinCode).toMatch(/^[A-Z2-9]{10}$/);
    const rows = await t.db
      .select()
      .from(leagues)
      .where(eq(leagues.kind, "private"));
    expect(rows).toHaveLength(2);
  });

  it("a collision inside the caller's transaction is retried in it", async () => {
    const spy = vi.spyOn(crypto, "getRandomValues");
    for (let i = 0; i < 4; i++) {
      spy.mockImplementationOnce(((bytes: Uint8Array) =>
        bytes.fill(0)) as never);
    }
    const first = await privateLeague("Friends");
    // The failed insert would abort the outer transaction (25P02) without a
    // savepoint around each attempt.
    const second = await t.db.transaction((tx) =>
      createLeague(tx, NOW, {
        gameId,
        ownerUserId: userA,
        kind: "private",
        name: "Friends",
      }),
    );
    expect(first.joinCode).toBe("AAAAAAAAAA");
    expect(second.joinCode).not.toBe(first.joinCode);
    const rows = await t.db
      .select()
      .from(leagues)
      .where(eq(leagues.kind, "private"));
    expect(rows).toHaveLength(2);
  });

  it("a public league has a code too, and an auto league has none to join by", async () => {
    const { joinCode } = await createLeague(t.db, NOW, {
      gameId,
      ownerUserId: userA,
      kind: "public",
      name: "Open to all",
    });
    expect(joinCode).toHaveLength(10);
    await joinLeague(t.db, LATER, { joinCode, teamId: teamB, userId: userB });
    expect(await currentLeagues(teamB)).toEqual(["Open to all"]);

    await syncAutoLeagues(t.db, LATER, {
      userId: userA,
      gameId,
      constructorId: seeded.constructorIds[0]!,
      driverId: null,
      countryCode: null,
    });
    const [auto] = await t.db
      .select()
      .from(leagues)
      .where(eq(leagues.kind, "auto_constructor"));
    expect(auto!.joinCode).toBeNull();
    // Nor does a team leave one by hand.
    await expectGameError(
      leaveLeague(t.db, LATEST, {
        leagueId: auto!.id,
        teamId: teamA,
        userId: userA,
      }),
      "league_not_found",
    );
  });

  it("a league name is 1 to 40 characters, and the range and limit make sense", async () => {
    const base = { gameId, ownerUserId: userA, kind: "private" as const };
    await expectGameError(
      createLeague(t.db, NOW, { ...base, name: "   " }),
      "bad_name",
    );
    await expectGameError(
      createLeague(t.db, NOW, { ...base, name: "x".repeat(41) }),
      "bad_name",
    );
    await expect(
      createLeague(t.db, NOW, { ...base, name: "Late", startSequence: 0 }),
    ).rejects.toThrow(/start/);
    await expect(
      createLeague(t.db, NOW, {
        ...base,
        name: "Backwards",
        startSequence: 5,
        endSequence: 4,
      }),
    ).rejects.toThrow(/end/);
    await expect(
      createLeague(t.db, NOW, { ...base, name: "Empty", maxMembers: 0 }),
    ).rejects.toThrow(/limit/);
    // A name is trimmed, and two leagues can share one.
    const a = await createLeague(t.db, NOW, { ...base, name: "  Same  " });
    const b = await createLeague(t.db, NOW, { ...base, name: "Same" });
    const rows = await t.db
      .select()
      .from(leagues)
      .where(eq(leagues.kind, "private"));
    expect(rows.map((l) => l.name)).toEqual(["Same", "Same"]);
    expect(new Set(rows.map((l) => l.slug)).size).toBe(2);
    // The slug is no part of the code.
    for (const row of rows) {
      expect(row.slug.toUpperCase()).not.toContain(row.joinCode!.slice(0, 4));
    }
    expect(a.joinCode).not.toBe(b.joinCode);
  });

  it("a team can't be in a league twice at a time", async () => {
    const { leagueId, joinCode } = await privateLeague();
    const input = { joinCode, teamId: teamB, userId: userB };
    await joinLeague(t.db, LATER, input);
    await expectGameError(joinLeague(t.db, LATEST, input), "already_member");
    expect(await memberships(teamB)).toHaveLength(1);

    // The database says the same to anything that skips the check.
    await expectPgError(
      t.db.insert(leagueMemberships).values({
        id: newId(),
        leagueId,
        teamId: teamB,
        joinedAt: LATEST,
        source: "user",
      }),
      "23505",
    );
  });

  it("only the owner of a team can put it in a league, or take it out", async () => {
    const { leagueId, joinCode } = await privateLeague();
    await expectGameError(
      joinLeague(t.db, LATER, { joinCode, teamId: teamB, userId: userA }),
      "team_not_owned",
    );
    await expectGameError(
      joinLeague(t.db, LATER, { joinCode, teamId: newId(), userId: userB }),
      "team_not_owned",
    );
    await joinLeague(t.db, LATER, { joinCode, teamId: teamB, userId: userB });
    await expectGameError(
      leaveLeague(t.db, LATEST, { leagueId, teamId: teamB, userId: userA }),
      "team_not_owned",
    );
    expect(await currentLeagues(teamB)).toEqual(["Friends"]);
  });

  it("a league with a limit refuses a member past it, until one leaves", async () => {
    const { leagueId, joinCode } = await createLeague(t.db, NOW, {
      gameId,
      ownerUserId: userA,
      kind: "private",
      name: "Small",
      maxMembers: 1,
    });
    await joinLeague(t.db, LATER, { joinCode, teamId: teamA, userId: userA });
    await expectGameError(
      joinLeague(t.db, LATER, { joinCode, teamId: teamB, userId: userB }),
      "league_full",
    );
    await leaveLeague(t.db, LATEST, { leagueId, teamId: teamA, userId: userA });
    await joinLeague(t.db, LATEST, { joinCode, teamId: teamB, userId: userB });
    expect(await currentLeagues(teamB)).toEqual(["Small"]);
  });

  it("a retired team doesn't take a seat in a full league", async () => {
    const { leagueId, joinCode } = await createLeague(t.db, NOW, {
      gameId,
      ownerUserId: userA,
      kind: "private",
      name: "Small",
      maxMembers: 1,
    });
    await joinLeague(t.db, LATER, { joinCode, teamId: teamA, userId: userA });
    await retire(teamA);
    // The retired team is still a member, but holds no seat.
    await joinLeague(t.db, LATER, { joinCode, teamId: teamB, userId: userB });
    expect(await currentLeagues(teamB)).toEqual(["Small"]);
    // With teamB seated, the league is full for an active team.
    const userC = newId();
    const teamC = await team(userC);
    await expectGameError(
      joinLeague(t.db, LATEST, { joinCode, teamId: teamC, userId: userC }),
      "league_full",
    );
    expect((await memberships(teamA))[0]).toMatchObject({
      leagueId,
      leftAt: null,
    });
  });

  it("a retired team can't join", async () => {
    const { joinCode } = await privateLeague();
    await retire(teamB);
    await expectGameError(
      joinLeague(t.db, LATER, { joinCode, teamId: teamB, userId: userB }),
      "team_retired",
    );
    expect(await memberships(teamB)).toHaveLength(0);
  });

  it("the 51st user league is refused, and auto leagues don't count", async () => {
    // Auto memberships first: constructor, driver and country.
    await syncAutoLeagues(t.db, NOW, {
      userId: userB,
      gameId,
      constructorId: seeded.constructorIds[0]!,
      driverId: seeded.driverIds[0]!,
      countryCode: "GB",
    });
    expect(await memberships(teamB)).toHaveLength(3);

    const codes: { leagueId: string; joinCode: string }[] = [];
    for (let i = 0; i < LEAGUE_CAP + 1; i++) {
      codes.push(await privateLeague(`League ${i}`, userA));
    }
    for (const { joinCode } of codes.slice(0, LEAGUE_CAP)) {
      await joinLeague(t.db, LATER, { joinCode, teamId: teamB, userId: userB });
    }
    const last = codes[LEAGUE_CAP]!;
    await expectGameError(
      joinLeague(t.db, LATER, {
        joinCode: last.joinCode,
        teamId: teamB,
        userId: userB,
      }),
      "league_cap",
    );
    // The database holds the line for anything that skips the check.
    await expectPgError(
      t.db.insert(leagueMemberships).values({
        id: newId(),
        leagueId: last.leagueId,
        teamId: teamB,
        joinedAt: LATER,
        source: "user",
      }),
      "GL008",
    );

    // Another team of the user has its own 50, and leaving frees a place.
    const second = await team(userB);
    await joinLeague(t.db, LATER, {
      joinCode: last.joinCode,
      teamId: second,
      userId: userB,
    });
    await leaveLeague(t.db, LATEST, {
      leagueId: codes[0]!.leagueId,
      teamId: teamB,
      userId: userB,
    });
    await joinLeague(t.db, LATEST, {
      joinCode: last.joinCode,
      teamId: teamB,
      userId: userB,
    });
  });

  it("a team from another game can't join", async () => {
    const stranger = await team(userB, otherGameId);
    const { leagueId, joinCode } = await privateLeague();
    await expectGameError(
      joinLeague(t.db, LATER, { joinCode, teamId: stranger, userId: userB }),
      "league_not_found",
    );
    // The database refuses it too.
    await expect(
      t.db.insert(leagueMemberships).values({
        id: newId(),
        leagueId,
        teamId: stranger,
        joinedAt: LATER,
        source: "user",
      }),
    ).rejects.toThrow();
    expect(await memberships(stranger)).toHaveLength(0);
  });

  it("a membership's source has to fit its league", async () => {
    const { leagueId } = await privateLeague();
    await expect(
      t.db.insert(leagueMemberships).values({
        id: newId(),
        leagueId,
        teamId: teamB,
        joinedAt: LATER,
        source: "auto",
      }),
    ).rejects.toThrow();
  });

  it("leaving and rejoining keeps history", async () => {
    const { leagueId, joinCode } = await privateLeague();
    const input = { joinCode, teamId: teamB, userId: userB };
    await joinLeague(t.db, NOW, input);
    await leaveLeague(t.db, LATER, { leagueId, teamId: teamB, userId: userB });
    expect(await currentLeagues(teamB)).toEqual([]);
    await joinLeague(t.db, LATEST, input);

    expect(await memberships(teamB)).toMatchObject([
      { leagueId, joinedAt: NOW, leftAt: LATER },
      { leagueId, joinedAt: LATEST, leftAt: null },
    ]);
    // Leaving a league the team is not in is refused.
    await leaveLeague(t.db, LATEST, { leagueId, teamId: teamB, userId: userB });
    await expectGameError(
      leaveLeague(t.db, LATEST, { leagueId, teamId: teamB, userId: userB }),
      "league_not_found",
    );
  });

  it("changing the favorite constructor moves the auto membership", async () => {
    const [ferrari, mercedes] = seeded.constructorIds;
    const second = await team(userA);
    const sync = (
      now: Date,
      constructorId: string | null,
      userId = userA,
      driverId: string | null = null,
    ) =>
      syncAutoLeagues(t.db, now, {
        userId,
        gameId,
        constructorId,
        driverId,
        countryCode: null,
      });

    await sync(NOW, ferrari!);
    const autoOf = (id: string) =>
      t.db
        .select()
        .from(leagues)
        .where(and(eq(leagues.constructorId, id), eq(leagues.gameId, gameId)));
    const [first] = await autoOf(ferrari!);
    expect(first).toMatchObject({
      kind: "auto_constructor",
      joinCode: null,
      status: "active",
    });
    // Every active team of the user is in it; another user's isn't.
    for (const id of [teamA, second]) {
      expect(await memberships(id)).toMatchObject([
        { leagueId: first!.id, joinedAt: NOW, leftAt: null, source: "auto" },
      ]);
    }
    expect(await memberships(teamB)).toHaveLength(0);

    // Running it again changes nothing.
    await sync(LATER, ferrari!);
    expect(await memberships(teamA)).toHaveLength(1);

    // A new favorite: out of the old league, into the new one, made as needed.
    await sync(LATEST, mercedes!);
    const [next] = await autoOf(mercedes!);
    expect(next!.id).not.toBe(first!.id);
    for (const id of [teamA, second]) {
      expect(await memberships(id)).toMatchObject([
        { leagueId: first!.id, joinedAt: NOW, leftAt: LATEST },
        { leagueId: next!.id, joinedAt: LATEST, leftAt: null },
      ]);
    }

    // No favorite means no league of the kind, and the other kinds stay.
    await sync(LATEST, null, userA, seeded.driverIds[0]!);
    expect((await memberships(teamA)).map((m) => m.leftAt)).toEqual([
      LATEST,
      LATEST,
      null,
    ]);
    expect(await currentLeagues(teamA)).toHaveLength(1);

    // The league is the game's: another user's favorite lands in it.
    await sync(LATEST, mercedes!, userB);
    expect(await memberships(teamB)).toMatchObject([{ leagueId: next!.id }]);
    expect(await autoOf(mercedes!)).toHaveLength(1);
  });

  it("the auto league is keyed by constructor, so a rebrand keeps it", async () => {
    const constructorId = seeded.constructorIds[0]!;
    const sync = (userId: string, now: Date) =>
      syncAutoLeagues(t.db, now, {
        userId,
        gameId,
        constructorId,
        driverId: null,
        countryCode: null,
      });
    await sync(userA, NOW);
    const [before] = await t.db
      .select()
      .from(leagues)
      .where(eq(leagues.kind, "auto_constructor"));

    // The constructor is renamed; its ID is what the league follows.
    await t.db
      .update(constructors)
      .set({ name: "Rebranded Racing" })
      .where(eq(constructors.id, constructorId));
    await sync(userB, LATER);

    const after = await t.db
      .select()
      .from(leagues)
      .where(eq(leagues.kind, "auto_constructor"));
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(before!.id);
    expect((await memberships(teamA))[0]!.leagueId).toBe(before!.id);
    expect((await memberships(teamB))[0]!.leagueId).toBe(before!.id);
    // The name was taken from the constructor when the league was made.
    expect(before!.name).toMatch(/ fans$/);
  });

  it("auto leagues for a driver and a country, per game", async () => {
    const stranger = await team(userA, otherGameId);
    await syncAutoLeagues(t.db, NOW, {
      userId: userA,
      gameId,
      constructorId: null,
      driverId: seeded.driverIds[0]!,
      countryCode: " gb ",
    });
    const rows = await t.db
      .select()
      .from(leagues)
      .where(eq(leagues.gameId, gameId));
    const country = rows.find((l) => l.kind === "auto_country");
    expect(country).toMatchObject({ countryCode: "GB", slug: "country-gb" });
    expect(country!.name).toBe("United Kingdom fans");
    expect(rows.some((l) => l.kind === "auto_driver")).toBe(true);
    expect(await memberships(teamA)).toHaveLength(2);
    // The user's team in the other game is left alone.
    expect(await memberships(stranger)).toHaveLength(0);

    await expect(
      syncAutoLeagues(t.db, NOW, {
        userId: userA,
        gameId,
        constructorId: null,
        driverId: null,
        countryCode: "Great Britain",
      }),
    ).rejects.toThrow(/country/);
    await expect(
      syncAutoLeagues(t.db, NOW, {
        userId: userA,
        gameId,
        constructorId: newId(),
        driverId: null,
        countryCode: null,
      }),
    ).rejects.toThrow(/no constructor/);
  });

  it("a team deleted before it locked leaves its memberships with it", async () => {
    const { joinCode } = await privateLeague();
    await joinLeague(t.db, LATER, { joinCode, teamId: teamB, userId: userB });
    await syncAutoLeagues(t.db, LATER, {
      userId: userB,
      gameId,
      constructorId: seeded.constructorIds[0]!,
      driverId: null,
      countryCode: null,
    });
    expect(await removeTeam(t.db, LATEST, teamB)).toBe("deleted");
    expect(await memberships(teamB)).toHaveLength(0);
  });
});
