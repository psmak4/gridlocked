import { and, eq, inArray, isNull } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedLeagueGames } from "../../tests/helpers/leagues-game";
import { createTestDb } from "../../tests/helpers/test-db";
import { seedUser } from "../../tests/helpers/users";
import {
  events,
  gameEvents,
  leagueMemberships,
  leagues,
  profiles,
} from "@/db/schema";
import type { Db } from "@/db/types";
import type { Viewer } from "@/identity/viewer";
import { newId } from "@/lib/ids";
import { createLeague, joinLeague } from "@/leagues/leagues";
import {
  createLeagueAction,
  joinLeagueAction,
  leaveLeagueAction,
  leaguesPage,
  myLeagues,
} from "./leagues";
import { createTeamAction } from "./teams";

const NOW = new Date("2026-02-01T09:00:00.000Z");
const MINUTE = 60_000;

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

describe("leagues on the fantasy screens", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: Db;
  let gameId: string;
  let otherGameId: string;
  let driverIds: string[];

  beforeEach(async () => {
    t = await createTestDb();
    db = t.db as unknown as Db;
    ({ gameId, otherGameId, driverIds } = await seedLeagueGames(db, NOW));
  });

  afterEach(async () => {
    await t.close();
  });

  /** A user with one team in the current game. */
  async function player(name = "Late Brakers") {
    const userId = await seedUser(db);
    const viewer = await viewerOf(db, userId);
    const made = await createTeamAction(db, NOW, viewer, { name });
    expect(made).toMatchObject({ ok: true });
    const page = await leaguesPage(db, NOW, viewer);
    return { userId, viewer, teamId: page.teams[0]!.id };
  }

  it("a new team appears in Global and its auto leagues", async () => {
    const userId = await seedUser(db);
    await db
      .update(profiles)
      .set({ favoriteDriverId: driverIds[0]!, countryCode: "IT" })
      .where(eq(profiles.userId, userId));
    const viewer = await viewerOf(db, userId);
    expect(
      await createTeamAction(db, NOW, viewer, { name: "Late Brakers" }),
    ).toMatchObject({ ok: true });
    const page = await leaguesPage(db, NOW, viewer);
    expect(page.leagues.yours).toEqual([]);
    const auto = page.leagues.automatic;
    expect(auto.map((l) => l.kind)).toEqual([
      "global",
      "auto_driver",
      "auto_country",
    ]);
    expect(auto[0]).toMatchObject({
      name: "Everyone",
      teamName: "Late Brakers",
      rank: null,
      members: 1,
      joinCode: null,
    });
    expect(auto[2]!.name).toBe("Italy fans");
  });

  it("create a mini-league for rounds 5 to 9: its range is those events' sequences, and the owner's team is in it", async () => {
    const { viewer, teamId } = await player();
    const made = await createLeagueAction(db, NOW, viewer, {
      teamId,
      name: "  European summer ",
      kind: "private",
      startRound: 5,
      endRound: 9,
    });
    expect(made).toMatchObject({ ok: true });
    if (!made.ok) return;
    expect(made.joinCode).toMatch(/^[A-Z2-9]{10}$/);

    const sequenceOf = async (round: number) => {
      const [row] = await db
        .select({ sequence: gameEvents.sequence })
        .from(gameEvents)
        .innerJoin(events, eq(events.id, gameEvents.eventId))
        .where(and(eq(gameEvents.gameId, gameId), eq(events.round, round)));
      return row!.sequence;
    };
    const [league] = await db
      .select()
      .from(leagues)
      .where(eq(leagues.slug, made.slug));
    expect(league).toMatchObject({
      name: "European summer",
      kind: "private",
      startSequence: await sequenceOf(5),
      endSequence: await sequenceOf(9),
      ownerUserId: viewer.userId,
    });
    const members = await db
      .select({ teamId: leagueMemberships.teamId })
      .from(leagueMemberships)
      .where(
        and(
          eq(leagueMemberships.leagueId, league!.id),
          isNull(leagueMemberships.leftAt),
        ),
      );
    expect(members).toEqual([{ teamId }]);

    const page = await leaguesPage(db, NOW, viewer);
    expect(page.leagues.yours).toEqual([
      expect.objectContaining({
        name: "European summer",
        teamId,
        members: 1,
        rounds: { from: 5, to: 9 },
        joinCode: made.joinCode,
        mine: true,
        rank: null,
      }),
    ]);
  });

  it("rounds out of order are refused, and a round not in the game", async () => {
    const { viewer, teamId } = await player();
    expect(
      await createLeagueAction(db, NOW, viewer, {
        teamId,
        name: "Backwards",
        kind: "private",
        startRound: 9,
        endRound: 5,
      }),
    ).toEqual({ ok: false, error: "bad_range" });
    expect(
      await createLeagueAction(db, NOW, viewer, {
        teamId,
        name: "Too far",
        kind: "public",
        startRound: 29,
      }),
    ).toEqual({ ok: false, error: "bad_range" });
    expect(
      await createLeagueAction(db, NOW, viewer, {
        teamId,
        name: " ",
        kind: "public",
      }),
    ).toEqual({ ok: false, error: "bad_name" });
    expect(
      await db.select().from(leagues).where(eq(leagues.kind, "private")),
    ).toEqual([]);
  });

  it("join with a code in lower case and spaces", async () => {
    const owner = await player();
    const made = await createLeagueAction(db, NOW, owner.viewer, {
      teamId: owner.teamId,
      name: "Monday Night League",
      kind: "private",
    });
    if (!made.ok) throw new Error("not made");
    const friend = await player("Box Box");
    const typed = `${made.joinCode.slice(0, 5).toLowerCase()} ${made.joinCode.slice(5)}`;
    expect(
      await joinLeagueAction(db, NOW, friend.viewer, {
        code: typed,
        teamId: friend.teamId,
      }),
    ).toEqual({ ok: true, slug: made.slug, name: "Monday Night League" });
    const page = await leaguesPage(db, NOW, friend.viewer);
    expect(page.leagues.yours).toEqual([
      expect.objectContaining({ members: 2, mine: false }),
    ]);
    expect(
      await joinLeagueAction(db, NOW, friend.viewer, {
        code: made.joinCode,
        teamId: friend.teamId,
      }),
    ).toEqual({ ok: false, error: "already_member" });
  });

  it("Review Focus 5: the 11th try in 10 minutes is rate_limited, even with a right code", async () => {
    const owner = await player();
    const made = await createLeagueAction(db, NOW, owner.viewer, {
      teamId: owner.teamId,
      name: "Guess me",
      kind: "private",
    });
    if (!made.ok) throw new Error("not made");
    const guesser = await player("Guesser");
    for (let i = 0; i < 10; i++) {
      expect(
        await joinLeagueAction(
          db,
          new Date(NOW.getTime() + i * 1000),
          guesser.viewer,
          { code: `WRONGCODE${i}`, teamId: guesser.teamId },
        ),
      ).toEqual({ ok: false, error: "league_not_found" });
    }
    const right = { code: made.joinCode, teamId: guesser.teamId };
    expect(
      await joinLeagueAction(
        db,
        new Date(NOW.getTime() + 5 * MINUTE),
        guesser.viewer,
        right,
      ),
    ).toEqual({ ok: false, error: "rate_limited" });
    // A new window: the right code works.
    expect(
      await joinLeagueAction(
        db,
        new Date(NOW.getTime() + 11 * MINUTE),
        guesser.viewer,
        right,
      ),
    ).toMatchObject({ ok: true });
  });

  it("a wrong code and another game's code both read league_not_found", async () => {
    const { userId, viewer, teamId } = await player();
    const other = await createLeague(db, NOW, {
      gameId: otherGameId,
      ownerUserId: userId,
      kind: "private",
      name: "Last year",
    });
    for (const code of ["ABCDEFGHJK", other.joinCode]) {
      expect(await joinLeagueAction(db, NOW, viewer, { code, teamId })).toEqual(
        { ok: false, error: "league_not_found" },
      );
    }
  });

  it("a team in 50 leagues gets league_cap", async () => {
    const { userId, viewer, teamId } = await player();
    const owner = await seedUser(db);
    for (let i = 0; i < 50; i++) {
      const { joinCode } = await createLeague(db, NOW, {
        gameId,
        ownerUserId: owner,
        kind: "public",
        name: `League ${i}`,
      });
      await joinLeague(db, NOW, { joinCode, teamId, userId });
    }
    const { joinCode } = await createLeague(db, NOW, {
      gameId,
      ownerUserId: owner,
      kind: "public",
      name: "One too many",
    });
    expect(
      await joinLeagueAction(db, NOW, viewer, { code: joinCode, teamId }),
    ).toEqual({ ok: false, error: "league_cap" });
  });

  it("leave a league, and leaving an auto league is league_not_found", async () => {
    const { viewer, teamId } = await player();
    const made = await createLeagueAction(db, NOW, viewer, {
      teamId,
      name: "Short stay",
      kind: "public",
    });
    if (!made.ok) throw new Error("not made");
    const page = await leaguesPage(db, NOW, viewer);
    const mine = page.leagues.yours[0]!;
    expect(
      await leaveLeagueAction(db, NOW, viewer, {
        leagueId: mine.leagueId,
        teamId,
      }),
    ).toEqual({ ok: true });
    expect((await leaguesPage(db, NOW, viewer)).leagues.yours).toEqual([]);

    const global = page.leagues.automatic[0]!;
    expect(
      await leaveLeagueAction(db, NOW, viewer, {
        leagueId: global.leagueId,
        teamId,
      }),
    ).toEqual({ ok: false, error: "league_not_found" });
  });

  it("someone else's team can't join or leave", async () => {
    const owner = await player();
    const stranger = await player("Stranger");
    const made = await createLeagueAction(db, NOW, owner.viewer, {
      teamId: owner.teamId,
      name: "Mine",
      kind: "private",
    });
    if (!made.ok) throw new Error("not made");
    expect(
      await joinLeagueAction(db, NOW, stranger.viewer, {
        code: made.joinCode,
        teamId: owner.teamId,
      }),
    ).toEqual({ ok: false, error: "team_not_owned" });
    expect(
      await createLeagueAction(db, NOW, stranger.viewer, {
        teamId: owner.teamId,
        name: "Not mine",
        kind: "private",
      }),
    ).toEqual({ ok: false, error: "team_not_owned" });
    const rows = await myLeagues(db, NOW, {
      gameId,
      userId: stranger.userId,
      reader: null,
    });
    expect(rows.yours).toEqual([]);
    expect(
      await db
        .select()
        .from(leagueMemberships)
        .where(inArray(leagueMemberships.teamId, [stranger.teamId])),
    ).toEqual([]);
  });
});
