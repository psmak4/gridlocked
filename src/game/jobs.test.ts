import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq, inArray } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import {
  lockRound,
  round2026,
  seedGame2026,
} from "../../tests/helpers/game-2026";
import { allJobs } from "../../tests/helpers/pipeline-2026";
import {
  assetPrices,
  events,
  gameEvents,
  poolAssets,
  rulesetVersions,
  sessions,
  teamEventStates,
} from "@/db/schema";
import { simulatedClock } from "@/lib/clock";
import { newId } from "@/lib/ids";
import { gameLockKey, gameOpenKey, type GameOpenPayload } from "@/jobs/kinds";
import { enqueue } from "@/jobs/queue";
import { runDue } from "@/jobs/runner";
import { setSimulatedClock } from "@/replay/clock-loop";
import type { StaffActor } from "@/staff/roster";
import { RULESET_2026 } from "./ruleset";
import { openGame, saveLineup, type LineupPick } from "./lineups";
import { createGameHandlers, planGameJobs } from "./jobs";
import { withdrawPoolAsset } from "./pool";
import { priceList, publishPrices } from "./prices";
import { createTeam } from "./teams";

// The lock and open jobs over the recorded 2026 game. The jobs are driven the
// way the tick drives them: `runDue` with the simulated clock (and the
// database's `app_now()`) at the instant under test.

const NOW = new Date("2026-02-01T09:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const LEASE = 5 * MIN;
const ACTOR: StaffActor = { kind: "admin", label: "staff" };

describe("the game jobs (HLD §3.3)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let game: Awaited<ReturnType<typeof seedGame2026>>;
  let gameId: string;
  let round1: { id: string; lockAt: Date };
  let round2: { id: string; lockAt: Date };
  const clock = simulatedClock(NOW);

  beforeEach(async () => {
    t = await createTestDb();
    game = await seedGame2026(t.db, NOW);
    gameId = game.gameId;
    await at(NOW);
    round1 = await round2026(t.db, 1);
    round2 = await round2026(t.db, 2);
    await openGame(t.db, NOW, gameId);
  });
  afterEach(async () => {
    await t.close();
  });

  /** Both clocks: the one the handlers read and the database's. */
  async function at(instant: Date) {
    clock.set(instant);
    await setSimulatedClock(t.db, instant);
  }
  const run = (maxJobs = 20, handlers = createGameHandlers()) =>
    runDue(t.db, clock, handlers, { maxJobs, leaseMs: LEASE });
  const gameJobs = async () =>
    (await allJobs(t.db)).filter((j) => j.kind.startsWith("game_"));
  const jobByKey = async (key: string) =>
    (await allJobs(t.db)).find((j) => j.dedupeKey === key);
  const statusOf = async (eventId: string) =>
    (
      await t.db
        .select({ status: gameEvents.status })
        .from(gameEvents)
        .where(eq(gameEvents.eventId, eventId))
    )[0]!.status;
  const raceEnd = async (eventId: string) =>
    new Date(
      Math.max(
        ...(
          await t.db
            .select({ end: sessions.scheduledEnd })
            .from(sessions)
            .where(
              and(eq(sessions.eventId, eventId), eq(sessions.kind, "race")),
            )
        ).map((s) => s.end.getTime()),
      ),
    );
  const complete = (eventId: string) =>
    t.db
      .update(events)
      .set({ status: "completed" })
      .where(eq(events.id, eventId));
  /** Queues the open job of round 2 alone, as planning would. */
  const queueOpen = (runAt: Date) => {
    const payload: GameOpenPayload = { gameId, eventId: round2.id };
    return enqueue(t.db, {
      kind: "game_open",
      dedupeKey: gameOpenKey(gameId, round2.id),
      runAt,
      payload,
    });
  };
  /** Runs each pending open job of round 2 at its time until it is gone. */
  async function runOpenChain() {
    for (let i = 0; i < 60; i++) {
      const [next] = (await gameJobs()).filter(
        (j) => j.kind === "game_open" && j.status === "pending",
      );
      if (!next) return;
      await at(next.runAt);
      await run();
    }
    throw new Error("the open job never settled");
  }

  const picks = async (): Promise<LineupPick[]> => [
    ...(await Promise.all(
      ["norris", "piastri", "hulkenberg", "hadjar", "bearman"].map(
        async (key, i) => ({ assetId: await game.assetId(key), isBoost: !i }),
      ),
    )),
    ...(await Promise.all(
      ["haas", "audi"].map(async (key) => ({
        assetId: await game.assetId(key),
        isBoost: false,
      })),
    )),
  ];
  /** A team for a new user with a lineup saved an hour before round 1 locks. */
  async function teamWithLineup() {
    const saved = new Date(round1.lockAt.getTime() - HOUR);
    await at(saved);
    const teamId = await createTeam(t.db, saved, {
      gameId,
      userId: newId(),
      name: "T",
    });
    await saveLineup(t.db, saved, {
      teamId,
      picks: await picks(),
      basedOnVersionId: null,
    });
    return teamId;
  }
  const lockStates = () => t.db.select().from(teamEventStates);

  it("planning puts a lock job at each event's lock_at", async () => {
    await planGameJobs(t.db, gameId);

    const rows = await t.db
      .select({
        id: gameEvents.eventId,
        lockAt: events.lockAt,
        sequence: gameEvents.sequence,
      })
      .from(gameEvents)
      .innerJoin(events, eq(events.id, gameEvents.eventId))
      .where(inArray(gameEvents.status, ["upcoming", "open"]))
      .orderBy(asc(gameEvents.sequence));
    expect(rows.length).toBeGreaterThan(20);
    const locks = (await gameJobs()).filter((j) => j.kind === "game_lock");
    expect(locks).toHaveLength(rows.length);
    for (const row of rows) {
      expect(
        locks.find((j) => j.dedupeKey === `game_lock:${gameId}:${row.id}`),
      ).toMatchObject({
        status: "pending",
        runAt: row.lockAt,
        payload: { gameId, eventId: row.id },
      });
    }

    // An open job for each upcoming event after the first, 48 h after the
    // previous event's race ends (the last finalizer check).
    const opens = (await gameJobs()).filter((j) => j.kind === "game_open");
    expect(opens).toHaveLength(rows.length - 1);
    const second = await jobByKey(`game_open:${gameId}:${round2.id}`);
    expect(second).toMatchObject({
      status: "pending",
      payload: { gameId, eventId: round2.id },
    });
    expect(second!.runAt).toEqual(
      new Date((await raceEnd(round1.id)).getTime() + 48 * HOUR),
    );
    expect(await jobByKey(`game_open:${gameId}:${round1.id}`)).toBeUndefined();
  });

  it("planning skips events that have locked", async () => {
    await lockRound(t.db, gameId, round1.id);
    await planGameJobs(t.db, gameId);
    const keys = (await gameJobs()).map((j) => j.dedupeKey);
    expect(keys).not.toContain(`game_lock:${gameId}:${round1.id}`);
    expect(keys).toContain(`game_lock:${gameId}:${round2.id}`);
    expect(keys).toContain(`game_open:${gameId}:${round2.id}`);
  });

  it("planning again moves a job when lock_at moved", async () => {
    await planGameJobs(t.db, gameId);
    const before = (await gameJobs()).length;
    const moved = new Date(round2.lockAt.getTime() + 3 * HOUR);
    await t.db
      .update(events)
      .set({ lockAt: moved })
      .where(eq(events.id, round2.id));

    await planGameJobs(t.db, gameId);
    const jobsNow = await gameJobs();
    expect(jobsNow).toHaveLength(before);
    expect(await jobByKey(`game_lock:${gameId}:${round2.id}`)).toMatchObject({
      status: "pending",
      runAt: moved,
    });
  });

  it("a lock job that runs early because qualifying moved later reschedules and locks nothing", async () => {
    await teamWithLineup();
    await at(NOW);
    await planGameJobs(t.db, gameId);
    const later = new Date(round1.lockAt.getTime() + 2 * HOUR);
    await t.db
      .update(events)
      .set({ lockAt: later })
      .where(eq(events.id, round1.id));

    await at(round1.lockAt);
    expect(await run()).toEqual({ ran: 1, failed: 0, lost: 0 });

    expect(await statusOf(round1.id)).toBe("open");
    expect(await lockStates()).toEqual([]);
    // The job that ran is done; its successor waits for the new lock_at.
    const waiting = (await gameJobs()).filter(
      (j) =>
        j.kind === "game_lock" &&
        j.status === "pending" &&
        j.payload &&
        (j.payload as { eventId: string }).eventId === round1.id,
    );
    expect(waiting).toHaveLength(1);
    expect(waiting[0]).toMatchObject({
      dedupeKey: `game_lock:${gameId}:${round1.id}:wait:1`,
      runAt: later,
    });

    // At the new lock_at it locks.
    await at(later);
    expect(await run()).toEqual({ ran: 1, failed: 0, lost: 0 });
    expect(await statusOf(round1.id)).toBe("locked");
    expect(await lockStates()).toHaveLength(1);
  });

  it("planning again moves a lock job that already put itself off, when lock_at moves earlier", async () => {
    await planGameJobs(t.db, gameId);
    const later = new Date(round1.lockAt.getTime() + 2 * HOUR);
    await t.db
      .update(events)
      .set({ lockAt: later })
      .where(eq(events.id, round1.id));
    await at(round1.lockAt);
    expect(await run()).toEqual({ ran: 1, failed: 0, lost: 0 });
    const waitKey = `game_lock:${gameId}:${round1.id}:wait:1`;
    expect((await jobByKey(waitKey))!.runAt).toEqual(later);

    // The lock comes forward again: the live job is the wait job.
    const earlier = new Date(round1.lockAt.getTime() + HOUR);
    await t.db
      .update(events)
      .set({ lockAt: earlier })
      .where(eq(events.id, round1.id));
    await planGameJobs(t.db, gameId);

    const pending = (await gameJobs()).filter(
      (j) =>
        j.kind === "game_lock" &&
        j.status === "pending" &&
        (j.payload as { eventId: string }).eventId === round1.id,
    );
    expect(pending.map((j) => [j.dedupeKey, j.runAt])).toEqual([
      [waitKey, earlier],
    ]);
    await at(earlier);
    expect(await run(1)).toEqual({ ran: 1, failed: 0, lost: 0 });
    expect(await statusOf(round1.id)).toBe("locked");
  });

  it("a continuation that has to wait again isn't lost", async () => {
    await teamWithLineup();
    const second = await createTeam(t.db, clock.now(), {
      gameId,
      userId: newId(),
      name: "U",
    });
    await saveLineup(t.db, clock.now(), {
      teamId: second,
      picks: await picks(),
      basedOnVersionId: null,
    });
    await at(NOW);
    await planGameJobs(t.db, gameId);
    const batch = createGameHandlers({ batch: 1 });
    const move = (lockAt: Date) =>
      t.db.update(events).set({ lockAt }).where(eq(events.id, round1.id));

    // Run early once (wait:1), then lock one team and leave a continuation.
    const moved = new Date(round1.lockAt.getTime() + HOUR);
    await move(moved);
    await at(round1.lockAt);
    await run(1, batch);
    await at(moved);
    await run(1, batch);
    expect(await lockStates()).toHaveLength(1);
    expect(await statusOf(round1.id)).toBe("open");

    // The lock moves again before the continuation runs, so it has to wait.
    // The database refuses that once lock_at is past (as it should), so the
    // database's clock goes back for the move: the job's own defence is what
    // is under test.
    const again = new Date(moved.getTime() + HOUR);
    await setSimulatedClock(t.db, NOW);
    await move(again);
    clock.set(moved);
    expect(await run(1, batch)).toEqual({ ran: 1, failed: 0, lost: 0 });
    const live = (await gameJobs()).filter(
      (j) => j.kind === "game_lock" && j.status === "pending",
    );
    const mine = live.filter(
      (j) => (j.payload as { eventId: string }).eventId === round1.id,
    );
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      dedupeKey: `game_lock:${gameId}:${round1.id}:wait:2`,
      runAt: again,
    });

    await at(again);
    expect(await run(5, batch)).toMatchObject({ failed: 0 });
    expect(await lockStates()).toHaveLength(2);
    expect(await statusOf(round1.id)).toBe("locked");
  });

  it("a game whose rules say 12 and 4 opens 12 hours before the lock and re-checks every 4", async () => {
    // The version is not yet frozen: no event of the game has locked.
    const [version] = await t.db.select().from(rulesetVersions);
    await t.db
      .update(rulesetVersions)
      .set({
        params: {
          ...RULESET_2026,
          window: { openCutoffHours: 12, recheckHours: 4 },
        },
      })
      .where(eq(rulesetVersions.id, version!.id));
    await lockRound(t.db, gameId, round1.id);
    const first = new Date((await raceEnd(round1.id)).getTime() + 48 * HOUR);
    await queueOpen(first);

    await at(first);
    await run();
    expect(await jobByKey(`game_open:${gameId}:${round2.id}:1`)).toMatchObject({
      runAt: new Date(first.getTime() + 4 * HOUR),
    });

    await runOpenChain();
    expect(await statusOf(round2.id)).toBe("open");
    const [done] = (await gameJobs())
      .filter((j) => j.kind === "game_open" && j.status === "succeeded")
      .slice(-1);
    const cutoff = round2.lockAt.getTime() - 12 * HOUR;
    expect(done!.runAt.getTime()).toBeGreaterThanOrEqual(cutoff);
    expect(done!.runAt.getTime()).toBeLessThan(cutoff + 4 * HOUR);
  });

  it("a lock job at lock_at writes the lock record in batches, one job each", async () => {
    await teamWithLineup();
    const second = await createTeam(t.db, clock.now(), {
      gameId,
      userId: newId(),
      name: "U",
    });
    await saveLineup(t.db, clock.now(), {
      teamId: second,
      picks: await picks(),
      basedOnVersionId: null,
    });
    await at(NOW);
    await planGameJobs(t.db, gameId);

    await at(round1.lockAt);
    // One team per batch: the first job leaves the event open and queues the
    // next batch after its last team.
    expect(await run(1, createGameHandlers({ batch: 1 }))).toEqual({
      ran: 1,
      failed: 0,
      lost: 0,
    });
    expect(await statusOf(round1.id)).toBe("open");
    expect(await lockStates()).toHaveLength(1);
    const [first] = await lockStates();
    const next = (await gameJobs()).find(
      (j) =>
        j.status === "pending" &&
        j.dedupeKey.startsWith(`game_lock:${gameId}:${round1.id}:after:`),
    );
    expect(next).toMatchObject({
      dedupeKey: `game_lock:${gameId}:${round1.id}:after:${first!.teamId}`,
      runAt: round1.lockAt,
      payload: { afterTeamId: first!.teamId },
    });

    // The rest run until the event is locked.
    expect(await run(5, createGameHandlers({ batch: 1 }))).toMatchObject({
      failed: 0,
    });
    expect(await lockStates()).toHaveLength(2);
    expect(await statusOf(round1.id)).toBe("locked");
  });

  it("a lock job waits a few minutes for the event before it, and fails nothing", async () => {
    // Round 1 hasn't locked (its lock job is not queued), round 2's time comes.
    await enqueue(t.db, {
      kind: "game_lock",
      dedupeKey: gameLockKey(gameId, round2.id),
      runAt: round2.lockAt,
      payload: { gameId, eventId: round2.id },
    });
    await at(round2.lockAt);
    expect(await run(1)).toEqual({ ran: 1, failed: 0, lost: 0 });

    expect(await statusOf(round1.id)).toBe("open");
    expect(await statusOf(round2.id)).toBe("upcoming");
    expect(
      await jobByKey(`game_lock:${gameId}:${round2.id}:wait:1`),
    ).toMatchObject({
      status: "pending",
      runAt: new Date(round2.lockAt.getTime() + 5 * MIN),
      payload: { gameId, eventId: round2.id, wait: 1 },
    });
  });

  it("round 2 opens with carried prices once round 1 is completed", async () => {
    await lockRound(t.db, gameId, round1.id);
    await complete(round1.id);
    await planGameJobs(t.db, gameId);
    const planned = (await jobByKey(`game_open:${gameId}:${round2.id}`))!.runAt;
    await at(planned);
    expect(await statusOf(round2.id)).toBe("upcoming");

    expect(await run(1)).toEqual({ ran: 1, failed: 0, lost: 0 });

    expect(await statusOf(round2.id)).toBe("open");
    const [ge] = await t.db
      .select()
      .from(gameEvents)
      .where(eq(gameEvents.eventId, round2.id));
    expect(ge!.pricesReadyAt).toEqual(planned);
    const pool = await t.db
      .select({ id: poolAssets.id })
      .from(poolAssets)
      .where(eq(poolAssets.gameId, gameId));
    const prices = await t.db
      .select()
      .from(assetPrices)
      .where(eq(assetPrices.eventId, round2.id));
    expect(prices).toHaveLength(pool.length);
    expect(new Set(prices.map((p) => p.source))).toEqual(new Set(["carried"]));
    // Nothing is left to re-check.
    expect(
      (await gameJobs()).filter(
        (j) =>
          j.kind === "game_open" &&
          j.status === "pending" &&
          (j.payload as { eventId: string }).eventId === round2.id,
      ),
    ).toEqual([]);
  });

  it("round 2 stays closed while round 1 is not completed, re-checking every 6 hours", async () => {
    await lockRound(t.db, gameId, round1.id);
    const first = new Date((await raceEnd(round1.id)).getTime() + 48 * HOUR);
    await queueOpen(first);

    await at(first);
    expect(await run()).toEqual({ ran: 1, failed: 0, lost: 0 });
    expect(await statusOf(round2.id)).toBe("upcoming");
    expect(await jobByKey(`game_open:${gameId}:${round2.id}:1`)).toMatchObject({
      status: "pending",
      runAt: new Date(first.getTime() + 6 * HOUR),
      payload: { gameId, eventId: round2.id, attempt: 1 },
    });

    await at(new Date(first.getTime() + 6 * HOUR));
    expect(await run()).toEqual({ ran: 1, failed: 0, lost: 0 });
    expect(await statusOf(round2.id)).toBe("upcoming");
    expect(await jobByKey(`game_open:${gameId}:${round2.id}:2`)).toMatchObject({
      status: "pending",
      runAt: new Date(first.getTime() + 12 * HOUR),
    });

    // Round 1 completes: the next re-check opens round 2.
    await complete(round1.id);
    await at(new Date(first.getTime() + 12 * HOUR));
    expect(await run()).toEqual({ ran: 1, failed: 0, lost: 0 });
    expect(await statusOf(round2.id)).toBe("open");
  });

  it("round 2 opens with carried prices 24 hours before its lock even if round 1 is still under review", async () => {
    await lockRound(t.db, gameId, round1.id);
    const first = new Date((await raceEnd(round1.id)).getTime() + 48 * HOUR);
    await queueOpen(first);
    const cutoff = round2.lockAt.getTime() - 24 * HOUR;
    expect(first.getTime()).toBeLessThan(cutoff);

    await runOpenChain();

    expect(await statusOf(round2.id)).toBe("open");
    const [done] = (await gameJobs())
      .filter((j) => j.kind === "game_open" && j.status === "succeeded")
      .slice(-1);
    // Opened by the first check at or after the cutoff, not before it.
    expect(done!.runAt.getTime()).toBeGreaterThanOrEqual(cutoff);
    expect(done!.runAt.getTime()).toBeLessThan(cutoff + 6 * HOUR);
    const prices = await t.db
      .select()
      .from(assetPrices)
      .where(eq(assetPrices.eventId, round2.id));
    expect(prices.length).toBeGreaterThan(0);
    expect(new Set(prices.map((p) => p.source))).toEqual(new Set(["carried"]));
  });

  it("round 2 never opens before round 1 is locked", async () => {
    // Round 1 is completed but still open: its lock has not run.
    await complete(round1.id);
    const first = new Date((await raceEnd(round1.id)).getTime() + 48 * HOUR);
    await queueOpen(first);

    await at(first);
    // A refusal from the database (GL005) would fail the job.
    expect(await run()).toEqual({ ran: 1, failed: 0, lost: 0 });
    expect(await statusOf(round2.id)).toBe("upcoming");
    expect(await statusOf(round1.id)).toBe("open");
    expect(await jobByKey(`game_open:${gameId}:${round2.id}:1`)).toMatchObject({
      status: "pending",
      runAt: new Date(first.getTime() + 6 * HOUR),
    });
    const prices = await t.db
      .select()
      .from(assetPrices)
      .where(eq(assetPrices.eventId, round2.id));
    expect(prices).toEqual([]);

    // Once round 1 locks, the next check opens round 2.
    await lockRound(t.db, gameId, round1.id);
    await at(new Date(first.getTime() + 6 * HOUR));
    expect(await run()).toEqual({ ran: 1, failed: 0, lost: 0 });
    expect(await statusOf(round2.id)).toBe("open");
  });
  /**
   * An admin publishes a full list for round 2 at `now`: round 1's price for
   * every asset whose pool status is `active`.
   */
  async function publishActiveList(now: Date) {
    const active = new Set(
      (
        await t.db
          .select({ id: poolAssets.id })
          .from(poolAssets)
          .where(
            and(eq(poolAssets.gameId, gameId), eq(poolAssets.status, "active")),
          )
      ).map((a) => a.id),
    );
    await publishPrices(t.db, now, {
      gameId,
      eventId: round2.id,
      source: "admin",
      reason: "Prices after Australia",
      actor: ACTOR,
      prices: [...(await priceList(t.db, { gameId, eventId: round1.id }))]
        .filter(([assetId]) => active.has(assetId))
        .map(([assetId, price]) => ({ assetId, price })),
    });
  }
  /** Round 1 is completed, and round 2's planned open job runs. */
  async function openRound2() {
    await complete(round1.id);
    await planGameJobs(t.db, gameId);
    const planned = (await jobByKey(`game_open:${gameId}:${round2.id}`))!.runAt;
    await at(planned);
    expect(await run(1)).toEqual({ ran: 1, failed: 0, lost: 0 });
    expect(await statusOf(round2.id)).toBe("open");
    return planned;
  }

  it("an owned asset withdrawn from round 2 has its price carried when round 2 opens, after a full list was published", async () => {
    const teamId = await teamWithLineup();
    const locked = await lockRound(t.db, gameId, round1.id);
    const bearman = await game.assetId("bearman");
    await withdrawPoolAsset(t.db, locked, {
      assetId: bearman,
      fromEventId: round2.id,
      reason: "Leaves the grid",
      actor: ACTOR,
    });
    await publishActiveList(locked);
    const opened = await openRound2();

    // The team still owns Bearman: it can save and lock with him, at his
    // carried price.
    const saved = await saveLineup(t.db, opened, {
      teamId,
      picks: await picks(),
      basedOnVersionId: null,
    });
    await lockRound(t.db, gameId, round2.id);
    expect(
      (await lockStates()).find((s) => s.eventId === round2.id),
    ).toMatchObject({ teamId, lockedVersionId: saved.versionId, bank: 50 });
    expect(
      (await priceList(t.db, { gameId, eventId: round2.id })).get(bearman),
    ).toBe(80);
  });

  it("an asset withdrawn from round 3 is still priced for round 2, where it can be bought", async () => {
    const teamId = await teamWithLineup();
    const bottas = await game.assetId("bottas");
    const round3 = await round2026(t.db, 3);
    // Its pool status is `withdrawn` at once, but it goes from round 3.
    await withdrawPoolAsset(t.db, NOW, {
      assetId: bottas,
      fromEventId: round3.id,
      reason: "Leaves after China",
      actor: ACTOR,
    });
    const locked = await lockRound(t.db, gameId, round1.id);
    await publishActiveList(locked);
    const opened = await openRound2();

    // Bearman (80) out, Bottas (36) in.
    const bearman = await game.assetId("bearman");
    const saved = await saveLineup(t.db, opened, {
      teamId,
      picks: (await picks()).map((p) =>
        p.assetId === bearman ? { assetId: bottas, isBoost: false } : p,
      ),
      basedOnVersionId: null,
    });
    await lockRound(t.db, gameId, round2.id);
    expect(
      (await lockStates()).find((s) => s.eventId === round2.id),
    ).toMatchObject({ teamId, lockedVersionId: saved.versionId, bank: 94 });
    expect(
      (await priceList(t.db, { gameId, eventId: round2.id })).get(bottas),
    ).toBe(36);
  });
  it("a list of the active assets isn't complete while a withdrawn asset is owned, or still pickable, at the event", async () => {
    await teamWithLineup();
    const round3 = await round2026(t.db, 3);
    const bottas = await game.assetId("bottas");
    const bearman = await game.assetId("bearman");
    await withdrawPoolAsset(t.db, NOW, {
      assetId: bottas,
      fromEventId: round3.id,
      reason: "Leaves after China",
      actor: ACTOR,
    });
    const locked = await lockRound(t.db, gameId, round1.id);
    await withdrawPoolAsset(t.db, locked, {
      assetId: bearman,
      fromEventId: round2.id,
      reason: "Leaves the grid",
      actor: ACTOR,
    });
    const readyAt = async () =>
      (
        await t.db
          .select()
          .from(gameEvents)
          .where(eq(gameEvents.eventId, round2.id))
      )[0]!.pricesReadyAt;
    const priceOne = (assetId: string, price: number) =>
      publishPrices(t.db, locked, {
        gameId,
        eventId: round2.id,
        source: "admin",
        reason: "Prices after Australia",
        actor: ACTOR,
        prices: [{ assetId, price }],
      });

    await publishActiveList(locked);
    expect(await readyAt()).toBeNull();
    // Bottas can still be bought at round 2...
    await priceOne(bottas, 36);
    expect(await readyAt()).toBeNull();
    // ...and the team owns Bearman.
    await priceOne(bearman, 80);
    expect(await readyAt()).toEqual(locked);
  });
});
