import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, asc, eq, ne } from "drizzle-orm";
import { createTestDb } from "../../../tests/helpers/test-db";
import { readFixture } from "../../../tests/helpers/fixtures";
import { seedGame2026 } from "../../../tests/helpers/game-2026";
import { events, gameEvents, teamEventStates, teams } from "@/db/schema";
import { gameScriptSchema } from "@/replay/game-script";
import { replaySeasonGame } from "./season-game";

// The M3 exit (Task 9): the 2026 season replayed on the simulated clock, with
// only the game's jobs on the real scheduler tick, for the scripted teams of
// tests/fixtures/game-2026-script.json. Its setup is the other game tests':
// the recorded reference data and the fixture's prices, as of 1 February.

const SEEDED_AT = new Date("2026-02-01T09:00:00.000Z");

const script = gameScriptSchema.parse(readFixture("game-2026-script.json"));

describe("the 2026 season replay", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let report: Awaited<ReturnType<typeof replaySeasonGame>>;

  // The whole season takes about 8 s here, inside the db project's limits.
  beforeAll(async () => {
    t = await createTestDb();
    report = await replaySeasonGame(t.db, script, {
      seed: (db) => seedGame2026(db, SEEDED_AT),
    });
  });
  afterAll(async () => {
    await t?.close();
  });

  it("the 2026 season replays with no rule violations", () => {
    expect(report.violations).toEqual([]);
  });

  it("every round but the cancelled one locks", async () => {
    const calendar = await t.db.select({ status: events.status }).from(events);
    const cancelled = calendar.filter((e) => e.status === "cancelled").length;
    expect(cancelled).toBe(1);
    expect(report.eventsCancelled).toBe(cancelled);
    expect(report.eventsLocked).toBe(calendar.length - cancelled);
    const game = await t.db
      .select({ status: gameEvents.status })
      .from(gameEvents)
      .where(ne(gameEvents.status, "cancelled"));
    expect(new Set(game.map((e) => e.status))).toEqual(new Set(["locked"]));
  });

  it("refused equals the script's expectRefused count", () => {
    const expected = script.actions.filter(
      (a) => a.kind === "expectRefused",
    ).length;
    expect(expected).toBeGreaterThan(0);
    expect(report.refused).toBe(expected);
  });

  it("every team in the script has a state row for each event it took part in", async () => {
    const labels = new Set(
      script.actions.flatMap((a) => (a.kind === "create" ? [a.team] : [])),
    );
    expect(labels.size).toBe(8);
    const order = await t.db
      .select({
        eventId: gameEvents.eventId,
        sequence: gameEvents.sequence,
        round: events.round,
      })
      .from(gameEvents)
      .innerJoin(events, eq(events.id, gameEvents.eventId))
      .where(eq(gameEvents.status, "locked"))
      .orderBy(asc(gameEvents.sequence));

    let rows = 0;
    for (const name of labels) {
      const [team] = await t.db
        .select()
        .from(teams)
        .where(eq(teams.name, name));
      expect(team, name).toBeDefined();
      // A team takes part from its first lock to the end of the season.
      const first = order.findIndex((e) => e.eventId === team!.firstEventId);
      expect(first, `${name} took part`).toBeGreaterThanOrEqual(0);
      const states = await t.db
        .select({ eventId: teamEventStates.eventId })
        .from(teamEventStates)
        .where(
          and(
            eq(teamEventStates.teamId, team!.id),
            eq(teamEventStates.gameId, team!.gameId),
          ),
        );
      expect(new Set(states.map((s) => s.eventId)), name).toEqual(
        new Set(order.slice(first).map((e) => e.eventId)),
      );
      rows += states.length;
      if (name === "Late joiner") expect(order[first]!.round).toBe(6);
      else expect(order[first]!.round, name).toBe(1);
    }
    expect(report.states).toBe(rows);
  });
});
