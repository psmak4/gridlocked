import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import { importReferenceFixtures2026 } from "../../tests/helpers/pipeline-2026";
import {
  events,
  gameEvents,
  jobs,
  reviewItems,
  rulesetVersions,
  scoringRules,
} from "@/db/schema";
import { newId } from "@/lib/ids";
import { setSimulatedClock } from "@/replay/clock-loop";
import { SCORING_RULES_2026 } from "@/scoring/rules";
import { createGame, planGameEvents } from "./games";
import { planGameJobs } from "./jobs";
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
    rules: SCORING_RULES_2026,
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

  it("createGame stores the 2026 rules with version 1", async () => {
    const { rulesetVersionId } = await createGame(t.db, NOW, input());
    const rows = await t.db
      .select()
      .from(scoringRules)
      .orderBy(asc(scoringRules.sessionKind), asc(scoringRules.sortOrder));
    expect(rows).toHaveLength(SCORING_RULES_2026.length);
    expect(rows.every((r) => r.rulesetVersionId === rulesetVersionId)).toBe(
      true,
    );
    const [version] = await t.db.select().from(rulesetVersions);
    expect(version!.version).toBe(1);
    expect(version!.id).toBe(rulesetVersionId);
    const stored = rows.map(
      ({ code, sessionKind, target, kind, category, params, sortOrder }) => ({
        code,
        sessionKind,
        target,
        kind,
        category,
        params,
        sortOrder,
      }),
    );
    const byCode = (a: { code: string }, b: { code: string }) =>
      a.code.localeCompare(b.code);
    expect(stored.sort(byCode)).toEqual([...SCORING_RULES_2026].sort(byCode));
  });

  it("createGame refuses a rule the schema refuses", async () => {
    const bad = SCORING_RULES_2026.map((r) =>
      r.code === "race.position" ? { ...r, params: { points: "x" } } : r,
    );
    await expect(
      createGame(t.db, NOW, { ...input(), rules: bad as never }),
    ).rejects.toThrow();
    expect(await t.db.select().from(rulesetVersions)).toEqual([]);
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
  it("a ruleset version from the open event or a locked one is dropped for an admin, and planning goes on", async () => {
    const { gameId, rulesetVersionId } = await createGame(t.db, NOW, input());
    const first = await roundEvent(1);
    const second = await roundEvent(2);
    const third = await roundEvent(3);
    const setStatus = (eventId: string, status: "open" | "locked") =>
      t.db
        .update(gameEvents)
        .set({ status })
        .where(eq(gameEvents.eventId, eventId));
    const addVersion = async (version: number, fromEventId: string) => {
      const id = newId();
      await t.db.insert(rulesetVersions).values({
        id,
        gameId,
        version,
        effectiveFromEventId: fromEventId,
        params: RULESET_2026,
        notes: "A change.",
        publishedAt: NOW,
      });
      return id;
    };
    // Round 1 locked, round 2 open. Two versions start where the window has
    // reached (rounds 1 and 2), one from the next upcoming round, and round 5
    // is called off in the same run.
    await setStatus(first.id, "locked");
    await setStatus(second.id, "open");
    await addVersion(2, first.id);
    await addVersion(3, second.id);
    const v4 = await addVersion(4, third.id);
    const fifth = await roundEvent(5);
    await t.db
      .update(events)
      .set({ status: "cancelled" })
      .where(eq(events.id, fifth.id));

    await planGameEvents(t.db, NOW, gameId);

    // The two are dropped, each with an item for an admin; the one from round
    // 3 applies, and the cancellation is planned.
    const rows = await calendar(gameId);
    for (const r of rows) {
      expect(r.rulesetVersionId).toBe(r.round < 3 ? rulesetVersionId : v4);
    }
    expect(rows[1]).toMatchObject({ status: "open", sequence: 2 });
    expect(rows[4]).toMatchObject({ status: "cancelled", sequence: null });
    expect(rows[5]!.sequence).toBe(5);
    const items = await t.db
      .select()
      .from(reviewItems)
      .where(eq(reviewItems.kind, "ruleset_version_refused"))
      .orderBy(asc(reviewItems.dedupeKey));
    expect(items).toMatchObject([
      {
        status: "open",
        severity: "warning",
        dedupeKey: `ruleset_version_refused:${gameId}:2`,
        eventId: first.id,
      },
      {
        status: "open",
        severity: "warning",
        dedupeKey: `ruleset_version_refused:${gameId}:3`,
        eventId: second.id,
      },
    ]);

    // The game's jobs are planned after it, and planning again adds nothing.
    await planGameJobs(t.db, NOW, gameId);
    expect(
      (await t.db.select().from(jobs)).filter((j) => j.kind === "game_lock"),
    ).toHaveLength(
      rows.filter((r) => r.status !== "cancelled" && r.status !== "locked")
        .length,
    );
    await planGameEvents(t.db, NOW, gameId);
    expect(await calendar(gameId)).toEqual(rows);
    expect(
      await t.db
        .select()
        .from(reviewItems)
        .where(eq(reviewItems.kind, "ruleset_version_refused")),
    ).toHaveLength(2);
  });
  it("a lock_at move that puts a version's event ahead of the open one drops it, and the rows keep their versions", async () => {
    const { gameId, rulesetVersionId } = await createGame(t.db, NOW, input());
    const second = await roundEvent(2);
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
    const first = await roundEvent(1);
    await t.db
      .update(gameEvents)
      .set({ status: "locked" })
      .where(eq(gameEvents.eventId, first.id));
    await t.db
      .update(gameEvents)
      .set({ status: "open" })
      .where(eq(gameEvents.eventId, second.id));
    // Round 4 now locks before the open round 2.
    await t.db
      .update(events)
      .set({ lockAt: new Date(second.lockAt.getTime() - HOUR) })
      .where(eq(events.id, fourth.id));

    await planGameEvents(t.db, NOW, gameId);

    for (const r of await calendar(gameId)) {
      expect(r.rulesetVersionId).toBe(r.round < 4 ? rulesetVersionId : v2);
    }
    expect(
      await t.db
        .select({ key: reviewItems.dedupeKey })
        .from(reviewItems)
        .where(eq(reviewItems.kind, "ruleset_version_refused")),
    ).toEqual([{ key: `ruleset_version_refused:${gameId}:2` }]);
  });
});
