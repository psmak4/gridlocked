import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { round2026 } from "../../tests/helpers/game-2026";
import {
  lateStewardsPenalty,
  replayScores2026,
} from "../../tests/helpers/replay-2026";
import { createTestDb } from "../../tests/helpers/test-db";
import { games, sessions, teamEventTotals, teams } from "@/db/schema";
import type { Db } from "@/db/types";
import { markWatched } from "@/spoilers/reveal";
import {
  assetSheet,
  correctionNote,
  teamBreakdown,
  type Breakdown,
} from "./breakdown";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

/** The replay runs in `beforeAll`: rounds 1 to 3 over the whole pipeline. */
const REPLAY_TIMEOUT_MS = 600_000;
/** A day after round 2's race: scored, not yet final (+48 h). */
const PROVISIONAL_AT = "2026-03-16T07:00:00Z";
/** After round 1 is final, before round 2 locks. */
const PENALTY_AT = "2026-03-11T12:00:00Z";

const unprotected = (userId: string) => ({
  userId,
  spoilerProtection: false,
});
const protectedReader = (userId: string) => ({
  userId,
  spoilerProtection: true,
});

const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);

describe("correctionNote", () => {
  it("says nothing for a first run", () => {
    expect(
      correctionNote([{ label: "Race", runs: 1, trigger: "results" }]),
    ).toBeNull();
  });

  it("one sentence per corrected session, by what started its run", () => {
    expect(
      correctionNote([
        { label: "Qualifying", runs: 2, trigger: "results" },
        { label: "Sprint", runs: 1, trigger: "results" },
        { label: "Race", runs: 3, trigger: "exception" },
      ]),
    ).toBe(
      "Qualifying results were updated after a stewards' decision. Race was voided.",
    );
    expect(
      correctionNote([{ label: "Race", runs: 2, trigger: "engine_change" }]),
    ).toBe("Race was rescored after a rules fix.");
    expect(
      correctionNote([{ label: "Race", runs: 2, trigger: "override" }]),
    ).toBe("Race results were corrected after the session.");
  });
});

describe("teamBreakdown, on the 2026 replay", () => {
  let t: TestDb;
  let db: Db;
  let gameId: string;
  let now: Date;
  let teamList: Array<{ id: string; userId: string; name: string }>;
  let provisional: Breakdown | null = null;

  beforeAll(async () => {
    t = await createTestDb();
    db = t.db as unknown as Db;
    await replayScores2026(t.db as never, {
      throughRound: 3,
      actions: [
        {
          at: PENALTY_AT,
          run: async (at) => {
            await lateStewardsPenalty(db, at, {
              round: 1,
              driver: "hamilton",
              seconds: 40,
              reason: "40 s post-race penalty",
            });
          },
        },
        {
          at: PROVISIONAL_AT,
          run: async (at) => {
            const [team] = await db
              .select({ id: teams.id, userId: teams.userId })
              .from(teams)
              .orderBy(asc(teams.name))
              .limit(1);
            provisional = await teamBreakdown(db, at, {
              teamId: team!.id,
              reader: unprotected(team!.userId),
            });
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
    teamList = await db
      .select({ id: teams.id, userId: teams.userId, name: teams.name })
      .from(teams)
      .orderBy(asc(teams.name));
  }, REPLAY_TIMEOUT_MS);

  afterAll(async () => {
    await t?.close();
  });

  it("base rows plus extras add up to the stored total, for every team at 3 events", async () => {
    let checked = 0;
    for (const team of teamList) {
      const totals = await db
        .select({
          points: teamEventTotals.points,
          bySession: teamEventTotals.pointsBySession,
          round: sql<number>`(select round from events where id = ${teamEventTotals.eventId})`,
        })
        .from(teamEventTotals)
        .where(eq(teamEventTotals.teamId, team.id));
      for (const stored of totals) {
        const b = await teamBreakdown(db, now, {
          teamId: team.id,
          reader: unprotected(team.userId),
          round: stored.round,
        });
        expect(b, `${team.name} round ${stored.round}`).not.toBeNull();
        expect(b!.total).toBe(stored.points);
        for (const s of b!.sessions.filter((x) => x.scored)) {
          const extras = b!.extras.filter((e) => e.sessionId === s.id);
          expect(
            sum(s.rows.map((r) => r.points)) + sum(extras.map((e) => e.points)),
            `${team.name} round ${stored.round} ${s.label}`,
          ).toBe(stored.bySession[s.id]);
          expect(s.points).toBe(stored.bySession[s.id]);
          for (const row of s.rows) {
            expect(sum(row.lines.map((l) => l.points))).toBe(row.points);
            expect(row.reason.length).toBeGreaterThan(0);
            expect(row.title.length).toBeGreaterThan(0);
          }
        }
        const all =
          sum(b!.sessions.flatMap((s) => s.rows.map((r) => r.points))) +
          sum(b!.extras.map((e) => e.points));
        expect(all, `${team.name} round ${stored.round}`).toBe(stored.points);
        checked++;
      }
    }
    // 3 events, round 2 a sprint weekend.
    expect(checked).toBeGreaterThanOrEqual(teamList.length * 2);
  });

  it("a team's latest event is the default, and rounds lists its events", async () => {
    const team = teamList[0]!;
    const b = await teamBreakdown(db, now, {
      teamId: team.id,
      reader: unprotected(team.userId),
    });
    expect(b!.event.round).toBe(3);
    expect(b!.rounds).toEqual(expect.arrayContaining([1, 2, 3]));
    expect(b!.sessions.map((s) => s.label)).toEqual(["Qualifying", "Race"]);
    const sprintWeekend = await teamBreakdown(db, now, {
      teamId: team.id,
      reader: unprotected(team.userId),
      round: 2,
    });
    expect(sprintWeekend!.sessions.map((s) => s.label)).toEqual([
      "Sprint",
      "Qualifying",
      "Race",
    ]);
    expect(
      await teamBreakdown(db, now, {
        teamId: team.id,
        reader: unprotected(team.userId),
        round: 9,
      }),
    ).toBeNull();
  });

  it("a hidden qualifying session has no rows and no points, and the total is null", async () => {
    const team = teamList[1]!;
    const round3 = await round2026(db, 3);
    const [race] = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(
        sql`${sessions.eventId} = ${round3.id} and ${sessions.kind} = 'race'`,
      );
    // Within 7 days of round 3: only the race is watched.
    await markWatched(db, now, { userId: team.userId, sessionIds: [race!.id] });
    const b = await teamBreakdown(db, now, {
      teamId: team.id,
      reader: protectedReader(team.userId),
    });
    const [quali, raceSession] = b!.sessions;
    expect(quali).toMatchObject({
      label: "Qualifying",
      scored: true,
      revealed: false,
      points: null,
      rows: [],
    });
    expect(raceSession!.revealed).toBe(true);
    expect(raceSession!.rows.length).toBeGreaterThan(0);
    expect(b!.total).toBeNull();
    // Only the race's own lines; the transfer penalty waits for every session.
    expect(b!.extras.every((e) => e.sessionId === race!.id)).toBe(true);

    // Show it reveals qualifying this once.
    const shown = await teamBreakdown(db, now, {
      teamId: team.id,
      reader: protectedReader(team.userId),
      show: [quali!.id],
    });
    expect(shown!.sessions[0]!.revealed).toBe(true);
    expect(shown!.total).not.toBeNull();
  });

  it("Review Focus 3: the response carries no figure for a hidden session", async () => {
    const team = teamList[2]!;
    const all = await teamBreakdown(db, now, {
      teamId: team.id,
      reader: unprotected(team.userId),
    });
    const hidden = await teamBreakdown(db, now, {
      teamId: team.id,
      reader: protectedReader(team.userId),
    });
    // Nothing of round 3 is watched: every scored session is covered.
    expect(
      hidden!.sessions.every((s) => !s.revealed && s.points === null),
    ).toBe(true);
    expect(hidden!.extras).toEqual([]);
    expect(hidden!.total).toBeNull();
    expect(hidden!.correction).toBeNull();
    const text = JSON.stringify(hidden);
    for (const s of all!.sessions) {
      expect(text).not.toContain(`"points":${s.points}`);
      for (const row of s.rows) {
        expect(text).not.toContain(row.reason);
      }
    }
    expect(text).not.toContain(`"total":${all!.total}`);
  });

  it("a stewards' change shows its correction note", async () => {
    const team = teamList[0]!;
    const b = await teamBreakdown(db, now, {
      teamId: team.id,
      reader: unprotected(team.userId),
      round: 1,
    });
    expect(b!.correction).toContain(
      "Race results were corrected after the session.",
    );
    // Round 3 had no change after its race.
    const round3 = await teamBreakdown(db, now, {
      teamId: team.id,
      reader: unprotected(team.userId),
      round: 3,
    });
    expect(round3!.correction ?? "").not.toContain("Race");
  });

  it("a provisional event says provisional, and a final one final", async () => {
    expect(provisional).not.toBeNull();
    expect(provisional!.event.round).toBe(2);
    expect(provisional!.status).toBe("provisional");
    const team = teamList[0]!;
    const final = await teamBreakdown(db, now, {
      teamId: team.id,
      reader: unprotected(team.userId),
      round: 1,
    });
    expect(final!.status).toBe("final");
  });

  it("the driver sheet's lines add up to the row", async () => {
    let rows = 0;
    for (const team of teamList.slice(0, 3)) {
      const b = await teamBreakdown(db, now, {
        teamId: team.id,
        reader: unprotected(team.userId),
        round: 2,
      });
      for (const s of b!.sessions) {
        for (const row of s.rows) {
          const sheet = await assetSheet(db, now, {
            gameId,
            assetId: row.assetId,
            eventId: b!.event.id,
            reader: unprotected(team.userId),
          });
          const mine = sheet.sessions.find((x) => x.id === s.id)!;
          expect(mine.points).toBe(row.points);
          expect(sum(mine.lines.map((l) => l.points))).toBe(row.points);
          expect(mine.lines).toEqual(row.lines);
          rows++;
        }
      }
    }
    expect(rows).toBeGreaterThan(0);

    // Logged out, within the window, nothing of round 3 shows.
    const round3 = await round2026(db, 3);
    const team = teamList[0]!;
    const b = await teamBreakdown(db, now, {
      teamId: team.id,
      reader: unprotected(team.userId),
    });
    const sheet = await assetSheet(db, now, {
      gameId,
      assetId: b!.sessions[1]!.rows[0]!.assetId,
      eventId: round3.id,
      reader: null,
    });
    expect(
      sheet.sessions.every((s) => s.points === null && s.lines.length === 0),
    ).toBe(true);
  });
});
