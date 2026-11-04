import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asc, eq, sql } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import { seedLeagueGames } from "../../tests/helpers/leagues-game";
import {
  gameEvents,
  leagueMemberships,
  leagueStandings,
  teamEventTotals,
  teams,
} from "@/db/schema";
import { createTeam, removeTeam } from "@/game/teams";
import { newId } from "@/lib/ids";
import { createLeague, joinLeague, leaveLeague } from "./leagues";
import { recomputeStandings } from "./standings";

// League standings (DM 4.7) over the recorded 2026 game. The tests write each
// team's event points straight into `team_event_totals`, so the numbers are
// plain: standings read only the points and the event sequence.

const NOW = new Date("2026-02-01T09:00:00.000Z");
const LATER = new Date("2026-02-01T10:00:00.000Z");

describe("league standings (DM 4.7)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let gameId: string;
  /** The game's events by sequence minus one. */
  let eventIds: string[];
  let owner: string;
  const users = new Map<string, string>();
  /** Join codes by league. */
  const codes = new Map<string, string>();
  let teamIds: Record<"a" | "b" | "c" | "d", string>;

  beforeEach(async () => {
    t = await createTestDb();
    ({ gameId, eventIds } = await seedLeagueGames(t.db, NOW));
    owner = newId();
    users.clear();
    codes.clear();
    teamIds = {
      a: await team("a"),
      b: await team("b"),
      c: await team("c"),
      d: await team("d"),
    };
  });
  afterEach(async () => {
    await t.close();
  });

  const team = async (name: string) => {
    const userId = newId();
    const id = await createTeam(t.db, NOW, { gameId, userId, name });
    users.set(id, userId);
    return id;
  };
  /**
   * The team's points for events 1, 2, 3...: its totals rows, with the running
   * total and the first time it was reached as the totals step would write
   * them (the rank is not read by standings).
   */
  const score = async (teamId: string, points: number[], from = 1) => {
    let running = 0;
    const history: number[] = [];
    for (const [i, p] of points.entries()) {
      running += p;
      history.push(running);
      const sequence = from + i;
      await t.db.insert(teamEventTotals).values({
        gameId,
        teamId,
        eventId: eventIds[sequence - 1]!,
        eventSequence: sequence,
        points: p,
        pointsBySession: {},
        cumulativePoints: running,
        firstReachedSequence:
          from + history.findIndex((total) => total >= running),
        globalRank: 1,
        status: "provisional",
        computedAt: NOW,
      });
    }
  };
  const rescore = (teamId: string, sequence: number, points: number) =>
    t.db
      .update(teamEventTotals)
      .set({ points })
      .where(
        sql`${teamEventTotals.teamId} = ${teamId} and ${teamEventTotals.eventSequence} = ${sequence}`,
      );
  /** Puts a team in a new league made with these options. */
  const league = async (
    members: string[],
    range: { startSequence?: number; endSequence?: number } = {},
  ) => {
    const { leagueId, joinCode } = await createLeague(t.db, NOW, {
      gameId,
      ownerUserId: owner,
      kind: "private",
      name: "League",
      ...range,
    });
    codes.set(leagueId, joinCode);
    for (const teamId of members) await join(leagueId, teamId, NOW);
    return leagueId;
  };
  const join = (leagueId: string, teamId: string, now: Date) =>
    joinLeague(t.db, now, {
      joinCode: codes.get(leagueId)!,
      teamId,
      userId: users.get(teamId)!,
    });
  const recompute = (sequence: number) =>
    recomputeStandings(t.db, NOW, {
      gameId,
      eventId: eventIds[sequence - 1]!,
    });
  const table = (leagueId: string) =>
    t.db
      .select()
      .from(leagueStandings)
      .where(eq(leagueStandings.leagueId, leagueId))
      .orderBy(asc(leagueStandings.rank), asc(leagueStandings.teamId));
  /** `[team, points, first reached, rank, previous rank]` per row. */
  const shape = async (leagueId: string) => {
    const names = new Map(Object.entries(teamIds).map(([k, v]) => [v, k]));
    return (await table(leagueId))
      .map((r) => [
        names.get(r.teamId),
        r.points,
        r.firstReachedSequence,
        r.rank,
        r.previousRank,
      ])
      .sort(
        (x, y) =>
          (x[3] as number) - (y[3] as number) ||
          `${x[0]}`.localeCompare(`${y[0]}`),
      );
  };

  it("a mini-league counts only its range", async () => {
    // A leads the season on its first event, then the range is a tie of four.
    await score(teamIds.a, [30, 5, 5]);
    await score(teamIds.b, [0, 10, 0]);
    await score(teamIds.c, [0, 4, 4]);
    await score(teamIds.d, [0, 5, 5]);
    const members = Object.values(teamIds);
    const season = await league(members);
    const mini = await league(members, { startSequence: 2, endSequence: 3 });
    const late = await league(members, { startSequence: 3 });

    // Event 3 is in all three ranges.
    expect(await recompute(3)).toEqual({ leagues: 3 });

    // The whole season: A is far ahead, and B reached 10 at event 2, before D.
    expect(await shape(season)).toEqual([
      ["a", 40, 3, 1, null],
      ["b", 10, 2, 2, null],
      ["d", 10, 3, 3, null],
      ["c", 8, 3, 4, null],
    ]);
    // Events 2 and 3: A's 30 doesn't count. B reached 10 at 2, before A and D
    // reached it at 3, so B takes the tie. A and D tie in full and share 2nd.
    expect(await shape(mini)).toEqual([
      ["b", 10, 2, 1, null],
      ["a", 10, 3, 2, null],
      ["d", 10, 3, 2, null],
      ["c", 8, 3, 4, null],
    ]);
    // From event 3 on: only that event's points.
    expect(await shape(late)).toEqual([
      ["a", 5, 3, 1, null],
      ["d", 5, 3, 1, null],
      ["c", 4, 3, 3, null],
      ["b", 0, 3, 4, null],
    ]);
    const [row] = await table(mini);
    expect(row).toMatchObject({
      throughEventId: eventIds[2],
      status: "provisional",
    });

    // Event 1 is outside the mini-league's range: it isn't rebuilt.
    await t.db
      .delete(leagueStandings)
      .where(eq(leagueStandings.leagueId, mini));
    expect(await recompute(1)).toEqual({ leagues: 1 });
    expect(await table(mini)).toHaveLength(0);
    expect(await table(season)).toHaveLength(4);
  });

  it("a range ends at the latest event that has totals", async () => {
    await score(teamIds.a, [3, 4]);
    await score(teamIds.b, [5, 1]);
    const open = await league([teamIds.a, teamIds.b], { startSequence: 1 });
    const wide = await league([teamIds.a, teamIds.b], {
      startSequence: 2,
      endSequence: 40,
    });
    await recompute(2);
    expect(await shape(open)).toEqual([
      ["a", 7, 2, 1, null],
      ["b", 6, 2, 2, null],
    ]);
    // Events 3 to 40 have no totals yet: the table runs through event 2.
    expect(await shape(wide)).toEqual([
      ["a", 4, 2, 1, null],
      ["b", 1, 2, 2, null],
    ]);
    expect((await table(wide))[0]!.throughEventId).toBe(eventIds[1]);
  });

  it("a member who joined late ranks on the whole range", async () => {
    await score(teamIds.a, [10, 10, 10]);
    await score(teamIds.b, [20, 20, 0]);
    const id = await league([teamIds.a]);
    // B joins after all three events were scored.
    await join(id, teamIds.b, LATER);
    await recompute(3);
    expect(await shape(id)).toEqual([
      ["b", 40, 2, 1, null],
      ["a", 30, 3, 2, null],
    ]);
  });

  it("a team that left or retired drops off the table", async () => {
    await score(teamIds.a, [9, 9]);
    await score(teamIds.b, [8, 8]);
    await score(teamIds.c, [7, 7]);
    await score(teamIds.d, [6, 6]);
    const id = await league(Object.values(teamIds));
    await recompute(2);
    expect((await shape(id)).map((row) => row[0])).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);

    // B leaves; C played event 1 so it is retired, not deleted.
    await leaveLeague(t.db, LATER, {
      leagueId: id,
      teamId: teamIds.b,
      userId: users.get(teamIds.b)!,
    });
    await t.db
      .update(teams)
      .set({ firstEventId: eventIds[0]! })
      .where(eq(teams.id, teamIds.c));
    expect(await removeTeam(t.db, LATER, teamIds.c)).toBe("retired");
    await recompute(2);
    expect(await shape(id)).toEqual([
      ["a", 18, 2, 1, null],
      ["d", 12, 2, 2, null],
    ]);
    // Its past totals stay.
    expect(
      await t.db
        .select()
        .from(teamEventTotals)
        .where(eq(teamEventTotals.teamId, teamIds.c)),
    ).toHaveLength(2);
    // B's membership is kept, closed.
    expect(
      await t.db
        .select({ leftAt: leagueMemberships.leftAt })
        .from(leagueMemberships)
        .where(eq(leagueMemberships.teamId, teamIds.b)),
    ).toEqual([{ leftAt: LATER }]);
  });

  it("previous_rank shows movement, and a correction keeps it", async () => {
    const id = await league([teamIds.a, teamIds.b, teamIds.c]);
    // After event 1: A, B, C. After event 2: C, B, A.
    await score(teamIds.a, [9, 0]);
    await score(teamIds.b, [6, 5]);
    await score(teamIds.c, [3, 20]);
    // Only event 1 has totals yet.
    await t.db
      .delete(teamEventTotals)
      .where(eq(teamEventTotals.eventSequence, 2));
    await recompute(1);
    expect(await shape(id)).toEqual([
      ["a", 9, 1, 1, null],
      ["b", 6, 1, 2, null],
      ["c", 3, 1, 3, null],
    ]);

    await score(teamIds.a, [0], 2);
    await score(teamIds.b, [5], 2);
    await score(teamIds.c, [20], 2);
    await recompute(2);
    expect(await shape(id)).toEqual([
      ["c", 23, 2, 1, 3],
      ["b", 11, 2, 2, 2],
      ["a", 9, 1, 3, 1],
    ]);
    expect((await table(id))[0]!.throughEventId).toBe(eventIds[1]);

    // A steward's correction to event 2 changes the order again, but the
    // arrows still show the move since event 1.
    await rescore(teamIds.c, 2, 1);
    await recompute(2);
    expect(await shape(id)).toEqual([
      ["b", 11, 2, 1, 2],
      ["a", 9, 1, 2, 1],
      ["c", 4, 2, 3, 3],
    ]);

    // Running it again changes nothing.
    const before = await table(id);
    await recompute(2);
    expect(await table(id)).toEqual(before);

    // A team that joins after event 1's table has no previous rank.
    const late = teamIds.d;
    await score(late, [0, 0]);
    await join(id, late, LATER);
    await recompute(2);
    expect((await shape(id)).find((row) => row[0] === "d")).toEqual([
      "d",
      0,
      1,
      4,
      null,
    ]);
  });

  it("the table is final once its through event is", async () => {
    await score(teamIds.a, [1, 2]);
    const id = await league([teamIds.a]);
    await t.db
      .update(gameEvents)
      .set({ status: "final" })
      .where(eq(gameEvents.eventId, eventIds[0]!));
    await recompute(2);
    expect((await table(id))[0]!.status).toBe("provisional");
    await t.db
      .update(gameEvents)
      .set({ status: "final" })
      .where(eq(gameEvents.eventId, eventIds[1]!));
    await recompute(2);
    expect((await table(id))[0]!.status).toBe("final");
  });

  it("a league with no totals yet, an archived one and the global one have no table", async () => {
    await score(teamIds.a, [4]);
    const empty = await league([teamIds.b]);
    const archived = await league([teamIds.a]);
    await t.db.execute(
      sql`update leagues set status = 'archived' where id = ${archived}`,
    );
    expect(await recompute(1)).toEqual({ leagues: 1 });
    expect(await table(empty)).toHaveLength(0);
    expect(await table(archived)).toHaveLength(0);
    expect(await t.db.select().from(leagueStandings)).toHaveLength(0);
  });

  it("an event outside the game, or a cancelled one, throws", async () => {
    await expect(
      recomputeStandings(t.db, NOW, { gameId, eventId: newId() }),
    ).rejects.toThrow(/no event/);
    await t.db
      .update(gameEvents)
      .set({ sequence: null, status: "cancelled" })
      .where(eq(gameEvents.eventId, eventIds[0]!));
    await expect(recompute(1)).rejects.toThrow(/no sequence/);
  });

  it("a 100k-member league is paged by rank", async () => {
    await score(teamIds.a, [3]);
    await score(teamIds.b, [2]);
    const id = await league([teamIds.a, teamIds.b]);
    await recompute(1);

    // Both ways of paging a long table read the (league_id, rank) index and
    // need no sort, however large the table is. The planner would scan a table
    // this small, so table scans are off for the plan.
    const plan = (query: ReturnType<typeof sql>) =>
      t.db.transaction(async (tx) => {
        await tx.execute(sql`set local enable_seqscan = off`);
        await tx.execute(sql`set local enable_bitmapscan = off`);
        const { rows } = await tx.execute(sql`explain ${query}`);
        return rows
          .map((row) => String((row as Record<string, unknown>)["QUERY PLAN"]))
          .join("\n");
      });
    const offset = await plan(
      sql`select * from league_standings where league_id = ${id} order by rank limit 50 offset 99950`,
    );
    const keyset = await plan(
      sql`select * from league_standings where league_id = ${id} and rank > 99950 order by rank limit 50`,
    );
    for (const text of [offset, keyset]) {
      expect(text).toContain("league_standings_league_id_rank_idx");
      expect(text).not.toMatch(/Sort/);
    }
  });
});
