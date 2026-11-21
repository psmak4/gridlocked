import { and, asc, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCalendar2026 } from "../../tests/helpers/calendar-2026";
import {
  lockRound,
  openRound,
  round2026,
  seedGame2026,
} from "../../tests/helpers/game-2026";
import { createMemoryDueStore } from "../../tests/helpers/memory-due-store";
import { createTestDb } from "../../tests/helpers/test-db";
import { seedUser } from "../../tests/helpers/users";
import {
  auditLog,
  chipPlays,
  events,
  gameSessionExceptions,
  jobs,
  sessions,
  threads,
} from "@/db/schema";
import {
  openSessionThreads,
  postResults,
  threadMode,
} from "@/community/session-threads";
import { playChip } from "@/game/chips";
import { openGame, saveLineup } from "@/game/lineups";
import { createTeam } from "@/game/teams";
import { DUE_KEY } from "@/jobs/due-times";
import { simulatedClock } from "@/lib/clock";
import { newId } from "@/lib/ids";
import { syncCalendar } from "@/reference/sync-calendar";
import { setSimulatedClock } from "@/replay/clock-loop";
import { StaffError } from "./errors";
import type { StaffActor } from "./roster";
import {
  calendarList,
  cancelEvent,
  eventDetail,
  followLockSession,
  setLockAt,
  setSessionStatus,
  setSessionTimes,
} from "./calendar";

const NOW = new Date("2026-02-01T09:00:00.000Z");
const HOUR = 3_600_000;
const REASON = "FIA moved qualifying";

describe("staff calendar (M8 Task 5)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let gameId: string;
  let game: Awaited<ReturnType<typeof seedGame2026>>;
  let actor: StaffActor;
  let round1: { id: string; lockAt: Date };
  let round2: { id: string; lockAt: Date };

  beforeEach(async () => {
    t = await createTestDb();
    game = await seedGame2026(t.db, NOW);
    gameId = game.gameId;
    await setSimulatedClock(t.db, NOW);
    await openGame(t.db, NOW, gameId);
    round1 = await round2026(t.db, 1);
    round2 = await round2026(t.db, 2);
    const admin = await seedUser(t.db, { role: "admin" });
    actor = { kind: "admin", label: null, userId: admin, requestId: "web:1" };
  });
  afterEach(async () => {
    await t.close();
  });

  const at = async (time: Date) => {
    await setSimulatedClock(t.db, time);
    return time;
  };
  const eventOf = async (id: string) =>
    (await t.db.select().from(events).where(eq(events.id, id)))[0]!;
  const sessionsOf = (eventId: string) =>
    t.db
      .select()
      .from(sessions)
      .where(eq(sessions.eventId, eventId))
      .orderBy(asc(sessions.scheduledStart));
  const lockSessionOf = async (eventId: string) => {
    const event = await eventOf(eventId);
    return (await sessionsOf(eventId)).find(
      (s) => s.id === event.lockSessionId,
    )!;
  };
  const audits = (action: string) =>
    t.db.select().from(auditLog).where(eq(auditLog.action, action));
  const refusal = async (promise: Promise<unknown>) => {
    const error = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(StaffError);
    return (error as StaffError).code;
  };

  it("setLockAt in the past is refused with lock_in_past, the event unchanged", async () => {
    const before = await eventOf(round2.id);
    expect(
      await refusal(
        setLockAt(t.db, NOW, actor, {
          eventId: round2.id,
          lockAt: new Date(NOW.getTime() - HOUR),
          reason: REASON,
        }),
      ),
    ).toBe("lock_in_past");
    expect(await eventOf(round2.id)).toEqual(before);
    expect(await audits("event.lock_at.update")).toHaveLength(0);
  });

  it("setLockAt on a lock that has passed is refused with lock_in_past", async () => {
    const after = await at(new Date(round1.lockAt.getTime() + HOUR));
    expect(
      await refusal(
        setLockAt(t.db, after, actor, {
          eventId: round1.id,
          lockAt: new Date(after.getTime() + 24 * HOUR),
          reason: REASON,
        }),
      ),
    ).toBe("lock_in_past");
    expect((await eventOf(round1.id)).lockAt).toEqual(round1.lockAt);
  });

  it("setLockAt sets lock_at_source admin, audits event.lock_at.update, and moves the due-times file earlier", async () => {
    const due = createMemoryDueStore({
      [DUE_KEY]: JSON.stringify({
        version: 1,
        generated_at: NOW.toISOString(),
        next_due_at: "2026-12-31T00:00:00.000Z",
      }),
    });
    const lockAt = new Date(round2.lockAt.getTime() - 2 * HOUR);
    await setLockAt(
      t.db,
      NOW,
      actor,
      { eventId: round2.id, lockAt, reason: REASON },
      due.store,
    );
    expect(await eventOf(round2.id)).toMatchObject({
      lockAt,
      lockAtSource: "admin",
    });
    expect(await audits("event.lock_at.update")).toMatchObject([
      {
        actorUserId: actor.userId,
        entityType: "event",
        entityId: round2.id,
        before: {
          lockAt: round2.lockAt.toISOString(),
          lockAtSource: "default",
        },
        after: { lockAt: lockAt.toISOString(), lockAtSource: "admin" },
        reason: REASON,
        requestId: "web:1",
      },
    ]);
    // The game's lock job moved with it, and the file says so.
    const [lockJob] = await t.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.kind, "game_lock"),
          eq(jobs.dedupeKey, `game_lock:${gameId}:${round2.id}`),
        ),
      );
    expect(lockJob!.runAt).toEqual(lockAt);
    const file = JSON.parse(due.objects.get(DUE_KEY)!);
    expect(Date.parse(file.next_due_at)).toBeLessThanOrEqual(lockAt.getTime());
  });

  it("the next calendar sync leaves an admin lock alone", async () => {
    const lockAt = new Date(round2.lockAt.getTime() - 2 * HOUR);
    await setLockAt(t.db, NOW, actor, {
      eventId: round2.id,
      lockAt,
      reason: REASON,
    });
    await syncCalendar(t.db, simulatedClock(NOW), 2026, {
      events: loadCalendar2026(),
      snapshotId: newId(),
    });
    expect(await eventOf(round2.id)).toMatchObject({
      lockAt,
      lockAtSource: "admin",
    });
  });

  it("followLockSession puts the lock back on its session's start and the source back to default", async () => {
    await setLockAt(t.db, NOW, actor, {
      eventId: round2.id,
      lockAt: new Date(round2.lockAt.getTime() - 2 * HOUR),
      reason: REASON,
    });
    await followLockSession(t.db, NOW, actor, {
      eventId: round2.id,
      reason: "Back to the schedule",
    });
    const lockSession = await lockSessionOf(round2.id);
    expect(await eventOf(round2.id)).toMatchObject({
      lockAt: lockSession.scheduledStart,
      lockAtSource: "default",
    });
    const changes = await audits("event.lock_at.update");
    expect(changes).toHaveLength(2);
    expect(changes[1]).toMatchObject({
      before: { lockAtSource: "admin" },
      after: { lockAtSource: "default" },
      reason: "Back to the schedule",
    });
  });

  it("setSessionTimes on a lock session with a default lock moves the lock with it", async () => {
    const lockSession = await lockSessionOf(round2.id);
    const start = new Date(lockSession.scheduledStart.getTime() + HOUR);
    const end = new Date(lockSession.scheduledEnd.getTime() + HOUR);
    await setSessionTimes(t.db, NOW, actor, {
      sessionId: lockSession.id,
      start,
      end,
      reason: REASON,
    });
    expect(await lockSessionOf(round2.id)).toMatchObject({
      scheduledStart: start,
      scheduledEnd: end,
      timeSource: "admin",
    });
    expect(await eventOf(round2.id)).toMatchObject({
      lockAt: start,
      lockAtSource: "default",
    });
    expect(await audits("session.times.update")).toMatchObject([
      { entityType: "session", entityId: lockSession.id, reason: REASON },
    ]);
    // A start after its end is refused.
    expect(
      await refusal(
        setSessionTimes(t.db, NOW, actor, {
          sessionId: lockSession.id,
          start: end,
          end: start,
          reason: REASON,
        }),
      ),
    ).toBe("invalid");
  });

  it("setSessionStatus cancelled skips the session for every running game and its thread gets no results post", async () => {
    const opened = await at(new Date(round1.lockAt.getTime() - 48 * HOUR));
    await openSessionThreads(t.db, opened, round1.id);
    const race = (await sessionsOf(round1.id)).find((s) => s.kind === "race")!;
    await setSessionStatus(t.db, opened, actor, {
      sessionId: race.id,
      status: "cancelled",
      reason: "Called off for weather",
    });
    expect(
      (await t.db.select().from(sessions).where(eq(sessions.id, race.id)))[0]!
        .status,
    ).toBe("cancelled");
    expect(
      await t.db
        .select({
          gameId: gameSessionExceptions.gameId,
          policy: gameSessionExceptions.policy,
        })
        .from(gameSessionExceptions)
        .where(eq(gameSessionExceptions.sessionId, race.id)),
    ).toEqual([{ gameId, policy: "skip" }]);
    expect(await postResults(t.db, opened, race.id)).toBe(false);
    expect(await audits("session.status.update")).toMatchObject([
      {
        entityId: race.id,
        before: { status: "scheduled" },
        after: { status: "cancelled" },
      },
    ]);
    // Back to scheduled: the session counts again.
    await setSessionStatus(t.db, opened, actor, {
      sessionId: race.id,
      status: "scheduled",
      reason: "Rescheduled for Monday",
    });
    expect(
      await t.db
        .select()
        .from(gameSessionExceptions)
        .where(eq(gameSessionExceptions.sessionId, race.id)),
    ).toEqual([]);
  });

  it("setSessionStatus suspended keeps the thread in chat mode past its end", async () => {
    const opened = await at(new Date(round1.lockAt.getTime() - 48 * HOUR));
    await openSessionThreads(t.db, opened, round1.id);
    const race = (await sessionsOf(round1.id)).find((s) => s.kind === "race")!;
    const during = new Date(race.scheduledStart.getTime() + HOUR);
    await setSessionStatus(t.db, during, actor, {
      sessionId: race.id,
      status: "suspended",
      reason: "Red flag",
    });
    const [row] = await t.db
      .select({
        status: sessions.status,
        opens: threads.chatOpensAt,
        closes: threads.chatClosesAt,
      })
      .from(sessions)
      .innerJoin(threads, eq(threads.sessionId, sessions.id))
      .where(eq(sessions.id, race.id));
    const late = new Date(race.scheduledEnd.getTime() + 3 * HOUR);
    expect(
      threadMode(
        late,
        { status: row!.status },
        {
          chatOpensAt: row!.opens,
          chatClosesAt: row!.closes,
        },
      ),
    ).toBe("chat");
    // live and completed are the clock's, not staff's.
    expect(
      await refusal(
        setSessionStatus(t.db, during, actor, {
          sessionId: race.id,
          // @ts-expect-error: not a status staff set.
          status: "completed",
          reason: "Done",
        }),
      ),
    ).toBe("invalid");
  });

  it("cancelEvent cancels its sessions, refunds a chip played for it, and audits event.cancel", async () => {
    const teamId = await createTeam(t.db, NOW, {
      gameId,
      userId: await seedUser(t.db),
      name: "One",
    });
    // 280 + 250 + 95 + 85 + 80 + 90 + 70 = 950, under the cap.
    const picks = [
      ...["norris", "piastri", "hulkenberg", "hadjar", "bearman"].map(
        async (key, i) => ({
          assetId: await game.assetId(key),
          isBoost: i === 0,
        }),
      ),
      ...["haas", "audi"].map(async (key) => ({
        assetId: await game.assetId(key),
        isBoost: false,
      })),
    ];
    await saveLineup(t.db, await at(new Date(round1.lockAt.getTime() - HOUR)), {
      teamId,
      picks: await Promise.all(picks),
      basedOnVersionId: null,
    });
    const locked = await lockRound(t.db, gameId, round1.id);
    const opened = await at(new Date(locked.getTime() + HOUR));
    await openRound(t.db, opened, gameId, round2.id);
    await playChip(t.db, opened, { teamId, chipCode: "chip_autopilot" });
    const when = await at(new Date(round2.lockAt.getTime() - HOUR));
    await cancelEvent(t.db, when, actor, {
      eventId: round2.id,
      reason: "Called off by the FIA",
    });
    expect((await eventOf(round2.id)).status).toBe("cancelled");
    expect(new Set((await sessionsOf(round2.id)).map((s) => s.status))).toEqual(
      new Set(["cancelled"]),
    );
    expect(
      (await t.db.select().from(chipPlays)).map((p) => [p.eventId, p.status]),
    ).toEqual([[round2.id, "refunded"]]);
    expect(await audits("event.cancel")).toMatchObject([
      {
        entityId: round2.id,
        before: { status: "scheduled" },
        after: { status: "cancelled" },
        reason: "Called off by the FIA",
      },
    ]);
  });

  it("cancelEvent on an event that has locked is refused with event_locked", async () => {
    const after = await at(new Date(round1.lockAt.getTime() + HOUR));
    expect(
      await refusal(
        cancelEvent(t.db, after, actor, {
          eventId: round1.id,
          reason: "Too late",
        }),
      ),
    ).toBe("event_locked");
    expect((await eventOf(round1.id)).status).toBe("scheduled");
    expect(await audits("event.cancel")).toHaveLength(0);
  });

  it("calendarList lists the season's events in round order, the next to lock marked", async () => {
    const list = await calendarList(t.db, NOW, 2026);
    expect(list.season).toBe(2026);
    expect(list.events.length).toBeGreaterThan(2);
    const [first, second] = list.events;
    expect(first).toMatchObject({
      id: round1.id,
      round: 1,
      lockAt: round1.lockAt.toISOString(),
      badge: { label: "Next", tone: "live" },
    });
    expect(first!.name).toMatch(/Grand Prix/);
    expect(first!.dates).toMatch(/\d/);
    expect(second!.badge.label).toBe("Scheduled");
    expect(list.cancelled).toBe(0);
    expect(list.rounds).toBe(list.events.length);
  });

  it("eventDetail gives the sessions and History from the event's and its sessions' audit rows", async () => {
    const lockSession = await lockSessionOf(round2.id);
    await setLockAt(t.db, NOW, actor, {
      eventId: round2.id,
      lockAt: new Date(round2.lockAt.getTime() - 2 * HOUR),
      reason: REASON,
    });
    await setSessionStatus(t.db, NOW, actor, {
      sessionId: lockSession.id,
      status: "suspended",
      reason: "Red flag",
    });
    const detail = await eventDetail(t.db, NOW, round2.id);
    expect(detail.event).toMatchObject({
      id: round2.id,
      round: 2,
      lockAtSource: "admin",
      lockSessionId: lockSession.id,
      canCancel: true,
      lockPassed: false,
    });
    expect(detail.sessions.map((s) => s.id)).toContain(lockSession.id);
    expect(detail.sessions.find((s) => s.id === lockSession.id)).toMatchObject({
      status: "suspended",
      label: "Sprint Qualifying",
    });
    expect(detail.history.map((h) => h.what)).toEqual([
      "Session status change",
      "Lock time change",
    ]);
    expect(detail.history[1]!.reason).toBe(REASON);
    await expect(eventDetail(t.db, NOW, newId())).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
