import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { seedLeagueGames } from "../../tests/helpers/leagues-game";
import { createTestDb } from "../../tests/helpers/test-db";
import { seedUser } from "../../tests/helpers/users";
import { leagues, profiles, sessions, teamEventTotals } from "@/db/schema";
import type { Db } from "@/db/types";
import { GameError } from "@/game/errors";
import { createTeam } from "@/game/teams";
import { createLeague, joinLeague } from "@/leagues/leagues";
import { recomputeStandings } from "@/leagues/standings";
import { rangeWords, standingsPage, tiebreakWords } from "./standings";

// Standings (M6 Task 13) over the recorded 2026 game. As in the league
// tables' own tests, each team's event points go straight into
// `team_event_totals`, so the numbers are plain.

const NOW = new Date("2026-02-01T09:00:00.000Z");

describe("league standings on the fantasy screens", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: Db;
  let gameId: string;
  let eventIds: string[];
  let owner: string;
  const users = new Map<string, string>();

  beforeEach(async () => {
    t = await createTestDb();
    db = t.db as unknown as Db;
    ({ gameId, eventIds } = await seedLeagueGames(db, NOW));
    owner = await seedUser(db);
    users.clear();
  });
  afterEach(async () => {
    await t.close();
  });

  const team = async (name: string) => {
    const userId = await seedUser(db);
    const id = await createTeam(db, NOW, { gameId, userId, name });
    users.set(id, userId);
    return id;
  };
  /** The team's points for events 1, 2, 3…, with a global rank given. */
  const score = async (
    teamId: string,
    points: number[],
    globalRanks: number[] = points.map(() => 1),
    /** Points already scored before these, from event `from`. */
    before: { from: number; history: number[] } = { from: 1, history: [] },
  ) => {
    const history = [...before.history];
    let running = history.at(-1) ?? 0;
    for (const [i, p] of points.entries()) {
      running += p;
      history.push(running);
      const sequence = before.from + i;
      await db.insert(teamEventTotals).values({
        gameId,
        teamId,
        eventId: eventIds[sequence - 1]!,
        eventSequence: sequence,
        points: p,
        pointsBySession: {},
        cumulativePoints: running,
        firstReachedSequence:
          1 + history.findIndex((total) => total >= running),
        globalRank: globalRanks[i]!,
        status: "provisional",
        computedAt: NOW,
      });
    }
  };
  /** A private league of these teams, recomputed through event `through`. */
  const league = async (
    members: string[],
    through: number,
    range: { startSequence?: number; endSequence?: number } = {},
  ) => {
    const made = await createLeague(db, NOW, {
      gameId,
      ownerUserId: owner,
      kind: "private",
      name: "Monday Night League",
      ...range,
    });
    for (const teamId of members) {
      await joinLeague(db, NOW, {
        joinCode: made.joinCode,
        teamId,
        userId: users.get(teamId)!,
      });
    }
    await recomputeStandings(db, NOW, {
      gameId,
      eventId: eventIds[through - 1]!,
    });
    return { ...made, slug: await slugOf(made.leagueId) };
  };
  const slugOf = async (leagueId: string) => {
    const [row] = await db
      .select({ slug: leagues.slug })
      .from(leagues)
      .where(eq(leagues.id, leagueId));
    return row!.slug;
  };
  const page = (
    slug: string,
    more: Partial<Parameters<typeof standingsPage>[2]> = {},
  ) =>
    standingsPage(db, NOW, {
      gameId,
      slug,
      reader: { userId: owner, spoilerProtection: true },
      ...more,
    });

  it("pages of 50 meet without a gap or a repeat", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 120; i++) {
      const id = await team(`Team ${i}`);
      // Every fifth pair ties, so some ranks are shared.
      await score(id, [1000 - Math.floor(i / 2) * (i % 5 === 0 ? 1 : 2)]);
      ids.push(id);
    }
    const { slug } = await league(ids, 1);
    const seen: string[] = [];
    let after: number | undefined = undefined;
    let pages = 0;
    for (;;) {
      const p = await page(slug, { afterRank: after });
      pages++;
      seen.push(...p.rows.map((r) => r.teamId));
      if (p.next === null) break;
      expect(p.rows.at(-1)!.rank).toBe(p.next);
      after = p.next;
    }
    expect(pages).toBe(3);
    expect(seen).toHaveLength(120);
    expect(new Set(seen).size).toBe(120);
  }, 120_000);

  it("See more with the version of the first page returns the next rows of that table", async () => {
    const ids: string[] = [];
    for (const [i, points] of [40, 30, 20, 10].entries()) {
      const id = await team(`Team ${i}`);
      await score(id, [points]);
      ids.push(id);
    }
    const { slug } = await league(ids, 1);
    const first = await page(slug, { limit: 2 });
    expect(first.version).not.toBe("");
    const more = await page(slug, {
      afterRank: first.next!,
      version: first.version,
      limit: 2,
    });
    expect(more.restarted).toBe(false);
    expect(more.version).toBe(first.version);
    expect(more.rows.map((r) => r.rank)).toEqual([3, 4]);
  });

  it("See more after an event is scored returns restarted: true and the new table's first page", async () => {
    const ids: string[] = [];
    for (const [i, points] of [40, 30, 20, 10].entries()) {
      const id = await team(`Team ${i}`);
      await score(id, [points]);
      ids.push(id);
    }
    const { slug, leagueId } = await league(ids, 1);
    const first = await page(slug, { limit: 2 });
    // Event 2 is scored, and turns the table upside down.
    for (const [i, id] of ids.entries()) {
      await score(id, [100 * (i + 1)], [4 - i], {
        from: 2,
        history: [[40, 30, 20, 10][i]!],
      });
    }
    await recomputeStandings(db, NOW, { gameId, eventId: eventIds[1]! });
    const more = await page(slug, {
      afterRank: first.next!,
      version: first.version,
      limit: 2,
    });
    expect(leagueId).toBeTruthy();
    expect(more.restarted).toBe(true);
    expect(more.version).not.toBe(first.version);
    expect(more.rows.map((r) => r.rank)).toEqual([1, 2]);
    expect(more.rows[0]!.teamId).toBe(ids[3]);
  });

  it("shared ranks show once each and the next rank skips", async () => {
    const a = await team("Apex Predators");
    const b = await team("Late Brakers");
    const c = await team("Box Box Bunch");
    const d = await team("Undercut Kings");
    await score(a, [50, 50]);
    await score(b, [40, 40]);
    await score(c, [40, 40]);
    await score(d, [10, 20]);
    const { slug } = await league([a, b, c, d], 2);
    const p = await page(slug, { limit: 2 });
    // The page grows to keep the tie on 80 together.
    expect(p.rows.map((r) => [r.teamName, r.rank, r.points])).toEqual([
      ["Apex Predators", 1, 100],
      expect.arrayContaining([2, 80]),
      expect.arrayContaining([2, 80]),
    ]);
    expect(p.next).toBe(2);
    const rest = await page(slug, { afterRank: p.next!, limit: 2 });
    expect(rest.rows.map((r) => [r.teamName, r.rank])).toEqual([
      ["Undercut Kings", 4],
    ]);
    expect(rest.next).toBeNull();
    expect(rest.rows[0]!.last).toBe(20);
  });

  it("a tie that runs to the end of the table offers no See more", async () => {
    const a = await team("Apex Predators");
    const b = await team("Late Brakers");
    const c = await team("Box Box Bunch");
    await score(a, [50]);
    await score(b, [40]);
    await score(c, [40]);
    const { slug } = await league([a, b, c], 1);
    const p = await page(slug, { limit: 2 });
    expect(p.rows.map((r) => r.rank)).toEqual([1, 2, 2]);
    expect(p.next).toBeNull();
  });

  it("the move is previous minus current", async () => {
    const a = await team("Apex Predators");
    const b = await team("Late Brakers");
    await score(a, [50], [1]);
    await score(b, [10], [2]);
    const made = await createLeague(db, NOW, {
      gameId,
      ownerUserId: owner,
      kind: "private",
      name: "Movers",
    });
    for (const teamId of [a, b]) {
      await joinLeague(db, NOW, {
        joinCode: made.joinCode,
        teamId,
        userId: users.get(teamId)!,
      });
    }
    await recomputeStandings(db, NOW, { gameId, eventId: eventIds[0]! });
    await score(a, [0], [2], { from: 2, history: [50] });
    await score(b, [60], [1], { from: 2, history: [10] });
    await recomputeStandings(db, NOW, { gameId, eventId: eventIds[1]! });
    const p = await page(await slugOf(made.leagueId));
    expect(p.rows.map((r) => [r.teamName, r.rank, r.move])).toEqual([
      ["Late Brakers", 1, 1],
      ["Apex Predators", 2, -1],
    ]);
    expect(p.through).toMatchObject({ round: 2 });

    // The global league reads the totals' ranks the same way.
    const global = await standingsPage(db, NOW, {
      gameId,
      slug: "global",
      reader: { userId: users.get(b)!, spoilerProtection: true },
    });
    expect(global.league.name).toBe("Everyone");
    expect(global.rows.map((r) => [r.teamName, r.rank, r.points])).toEqual([
      ["Late Brakers", 1, 70],
      ["Apex Predators", 2, 50],
    ]);
    expect(global.yours).toEqual([
      expect.objectContaining({ teamName: "Late Brakers", rank: 1, move: 1 }),
    ]);
  });

  it("Review Focus 3: while the last race is hidden, no rank, points or move is returned", async () => {
    const a = await team("Apex Predators");
    const b = await team("Late Brakers");
    await score(a, [50]);
    await score(b, [40]);
    const { slug } = await league([a, b], 1);
    const [race] = await db
      .select({ start: sessions.scheduledStart })
      .from(sessions)
      .where(
        and(eq(sessions.eventId, eventIds[0]!), eq(sessions.kind, "race")),
      );
    const during = new Date(race!.start.getTime() + 2 * 60 * 60 * 1000);
    const reader = { userId: users.get(b)!, spoilerProtection: true };
    const covered = await standingsPage(db, during, { gameId, slug, reader });
    expect(covered).toMatchObject({
      hidden: true,
      rows: [],
      yours: [],
      next: null,
    });
    expect(covered.hiddenSessionIds.length).toBeGreaterThan(0);
    expect(JSON.stringify(covered)).not.toMatch(/"points"|"rank"|"move"/);

    // "Show it" on this page: the table, for these sessions only.
    const shown = await standingsPage(db, during, {
      gameId,
      slug,
      reader,
      show: covered.hiddenSessionIds,
    });
    expect(shown.hidden).toBe(false);
    expect(shown.yours).toEqual([
      expect.objectContaining({
        teamName: "Late Brakers",
        rank: 2,
        mine: true,
      }),
    ]);
  });

  it("a mini-league's note names its rounds", async () => {
    expect(tiebreakWords(null)).toBe(
      "Teams on the same points are split by who got there first.",
    );
    expect(tiebreakWords({ from: 5, to: 9 })).toBe(
      "Teams on the same points are split by who got there first. Counts rounds 5 to 9 only.",
    );
    expect(tiebreakWords({ from: 6, to: null })).toMatch(
      /Counts from round 6 on\.$/,
    );
    expect(rangeWords(5, 9)).toBe("Rounds 5–9");
    expect(rangeWords(5, 5)).toBe("Round 5");

    const a = await team("Apex Predators");
    await score(a, [50, 20, 30]);
    const { slug } = await league([a], 3, { startSequence: 2, endSequence: 3 });
    const p = await page(slug);
    expect(p.league.range).toBe("Rounds 2–3");
    expect(p.tiebreak).toMatch(/Counts rounds 2 to 3 only\.$/);
    expect(p.rows[0]!.points).toBe(50);
  });

  it("a deleted user's team reads Deleted team", async () => {
    const a = await team("Apex Predators");
    const b = await team("Late Brakers");
    await score(a, [50]);
    await score(b, [40]);
    const { slug } = await league([a, b], 1);
    await db
      .update(profiles)
      .set({ status: "deleted" })
      .where(eq(profiles.userId, users.get(a)!));
    const p = await page(slug);
    expect(p.rows[0]).toMatchObject({
      teamName: "Deleted team",
      username: null,
      points: 50,
    });
    expect(p.rows[1]!.teamName).toBe("Late Brakers");
    expect(p.rows[1]!.username).not.toBeNull();
  });

  it("a private league is only for its members and owner", async () => {
    const a = await team("Apex Predators");
    await score(a, [50]);
    const { slug, joinCode } = await league([a], 1);
    const stranger = await seedUser(db);
    await expect(
      page(slug, { reader: { userId: stranger, spoilerProtection: true } }),
    ).rejects.toThrow(GameError);
    const member = await page(slug, {
      reader: { userId: users.get(a)!, spoilerProtection: true },
    });
    expect(member.league.joinCode).toBe(joinCode);
    expect(member.rows[0]!.mine).toBe(true);
  });
});
