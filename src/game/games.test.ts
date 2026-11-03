import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import { importReferenceFixtures2026 } from "../../tests/helpers/pipeline-2026";
import { events, gameEvents, rulesetVersions } from "@/db/schema";
import { newId } from "@/lib/ids";
import { setSimulatedClock } from "@/replay/clock-loop";
import { createGame, planGameEvents } from "./games";
import { RULESET_2026 } from "./ruleset";

// The game calendar over the recorded 2026 calendar: one game_events row per
// event, numbered by lock time, each with the ruleset version in force.

const NOW = new Date("2026-02-01T09:00:00.000Z");
const HOUR = 3_600_000;

describe("the game calendar (DM 3.3)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let seasonId: string;

  beforeEach(async () => {
    t = await createTestDb();
    ({ seasonId } = await importReferenceFixtures2026(t.db, NOW));
    // The database clock agrees with the app's: a lock can't move into its past.
    await setSimulatedClock(t.db, NOW);
  });
  afterEach(async () => {
    await t.close();
  });

  const input = () => ({
    seasonId,
    slug: "2026-fantasy",
    name: "2026 Fantasy",
    params: RULESET_2026,
    notes: "The 2026 rules.",
  });

  /** The game's events as (round, sequence, status, version), in round order. */
  async function calendar(gameId: string) {
    return t.db
      .select({
        eventId: events.id,
        round: events.round,
        lockAt: events.lockAt,
        sequence: gameEvents.sequence,
        status: gameEvents.status,
        rulesetVersionId: gameEvents.rulesetVersionId,
      })
      .from(gameEvents)
      .innerJoin(events, eq(events.id, gameEvents.eventId))
      .where(eq(gameEvents.gameId, gameId))
      .orderBy(asc(events.round));
  }

  async function roundEvent(round: number) {
    const [row] = await t.db
      .select()
      .from(events)
      .where(and(eq(events.seasonId, seasonId), eq(events.round, round)));
    return row!;
  }

  it("createGame numbers the season's events by lock time", async () => {
    const { gameId, rulesetVersionId } = await createGame(t.db, NOW, input());
    const rows = await calendar(gameId);
    expect(rows).toHaveLength(23);
    const byLock = [...rows].sort(
      (a, b) => a.lockAt.getTime() - b.lockAt.getTime(),
    );
    expect(byLock.map((r) => r.sequence)).toEqual(
      Array.from({ length: 23 }, (_, i) => i + 1),
    );
    expect(rows.every((r) => r.status === "upcoming")).toBe(true);
    expect(rows.every((r) => r.rulesetVersionId === rulesetVersionId)).toBe(
      true,
    );

    const [version] = await t.db.select().from(rulesetVersions);
    expect(version).toMatchObject({
      id: rulesetVersionId,
      gameId,
      version: 1,
      effectiveFromEventId: byLock[0]!.eventId,
      notes: "The 2026 rules.",
    });
    expect(version!.publishedAt).toEqual(NOW);
  });

  it("a second game for the same season and type is refused", async () => {
    await createGame(t.db, NOW, input());
    await expect(
      createGame(t.db, NOW, { ...input(), slug: "2026-fantasy-b" }),
    ).rejects.toThrow();
    await expect(createGame(t.db, NOW, input())).rejects.toThrow();
  });

  it("planning again changes nothing", async () => {
    const { gameId } = await createGame(t.db, NOW, input());
    const before = await t.db.select().from(gameEvents);
    await planGameEvents(t.db, new Date(NOW.getTime() + HOUR), gameId);
    expect(await t.db.select().from(gameEvents)).toEqual(before);
  });

  it("an event whose lock_at moves before lock is renumbered", async () => {
    const { gameId } = await createGame(t.db, NOW, input());
    const second = await roundEvent(2);
    const fifth = await roundEvent(5);
    await t.db
      .update(events)
      .set({ lockAt: new Date(second.lockAt.getTime() - HOUR) })
      .where(eq(events.id, fifth.id));
    await planGameEvents(t.db, NOW, gameId);
    const seq = Object.fromEntries(
      (await calendar(gameId)).map((r) => [r.round, r.sequence]),
    );
    expect(seq).toMatchObject({ 1: 1, 5: 2, 2: 3, 3: 4, 4: 5, 6: 6, 23: 23 });
  });

  it("a locked event keeps its sequence when the calendar changes", async () => {
    const { gameId } = await createGame(t.db, NOW, input());
    const first = await roundEvent(1);
    const second = await roundEvent(2);
    await t.db
      .update(gameEvents)
      .set({ status: "locked" })
      .where(eq(gameEvents.eventId, first.id));
    // Round 1's lock moves after round 2's, and round 2 too moves later than 3.
    await t.db
      .update(events)
      .set({ lockAt: new Date(second.lockAt.getTime() + HOUR) })
      .where(eq(events.id, first.id));
    await planGameEvents(t.db, NOW, gameId);
    const rows = await calendar(gameId);
    const seq = Object.fromEntries(rows.map((r) => [r.round, r.sequence]));
    expect(seq[1]).toBe(1);
    expect(rows[0]!.status).toBe("locked");
    // The rest fill the other numbers, in lock order.
    expect(seq[2]).toBe(2);
    expect(new Set(Object.values(seq)).size).toBe(23);
  });

  it("a cancelled event has no sequence, and the rest close up", async () => {
    const { gameId } = await createGame(t.db, NOW, input());
    const third = await roundEvent(3);
    await t.db
      .update(events)
      .set({ status: "cancelled" })
      .where(eq(events.id, third.id));
    await planGameEvents(t.db, NOW, gameId);
    const rows = await calendar(gameId);
    expect(rows[2]).toMatchObject({ status: "cancelled", sequence: null });
    expect(rows[3]!.sequence).toBe(3);
    expect(rows[22]!.sequence).toBe(22);
  });

  it("a locked event stays locked, with its sequence, when its event is cancelled", async () => {
    const { gameId } = await createGame(t.db, NOW, input());
    const first = await roundEvent(1);
    await t.db
      .update(gameEvents)
      .set({ status: "locked" })
      .where(eq(gameEvents.eventId, first.id));
    // Called off after qualifying (DM 3.9): the game keeps what locked.
    await t.db
      .update(events)
      .set({ status: "cancelled" })
      .where(eq(events.id, first.id));
    await planGameEvents(t.db, NOW, gameId);
    const rows = await calendar(gameId);
    expect(rows[0]).toMatchObject({ status: "locked", sequence: 1 });
    expect(rows[1]).toMatchObject({ status: "upcoming", sequence: 2 });
  });

  it("a second ruleset version applies from its event onward", async () => {
    const { gameId, rulesetVersionId } = await createGame(t.db, NOW, input());
    const fourth = await roundEvent(4);
    const v2 = newId();
    await t.db.insert(rulesetVersions).values({
      id: v2,
      gameId,
      version: 2,
      effectiveFromEventId: fourth.id,
      params: RULESET_2026,
      notes: "A change.",
      publishedAt: NOW,
    });
    await planGameEvents(t.db, NOW, gameId);
    const rows = await calendar(gameId);
    for (const r of rows) {
      expect(r.rulesetVersionId).toBe(r.round < 4 ? rulesetVersionId : v2);
    }
  });
});
