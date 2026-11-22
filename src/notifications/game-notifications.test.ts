import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import { seedLeagueGames } from "../../tests/helpers/leagues-game";
import { seedViewer } from "../../tests/helpers/community";
import { events, jobs, notifications } from "@/db/schema";
import { planGameJobs } from "@/game/jobs";
import { createTeam } from "@/game/teams";
import type { Viewer } from "@/identity/viewer";
import { lockReminderKey } from "@/jobs/kinds";
import { createLeague, joinLeague } from "@/leagues/leagues";
import { enqueue } from "@/jobs/queue";
import { runDue } from "@/jobs/runner";
import { simulatedClock } from "@/lib/clock";
import {
  createLockReminderHandler,
  LOCK_REMINDER_BATCH,
  remindLock,
} from "./lock-reminder";
import { inbox } from "./read";

// The game's notifications: a team joining your league, and the lock reminders.
const NOW = new Date("2026-02-01T09:00:00.000Z");
const HOUR = 3_600_000;

describe("game notifications (wave 4)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let gameId: string;
  let firstEventId: string;
  let owner: Viewer;
  let rival: Viewer;
  let ownerTeam: string;
  let rivalTeam: string;

  beforeEach(async () => {
    t = await createTestDb();
    const seeded = await seedLeagueGames(t.db, NOW);
    gameId = seeded.gameId;
    firstEventId = seeded.eventIds[0]!;
    owner = await seedViewer(t.db, { username: "owner" });
    rival = await seedViewer(t.db, { username: "rival" });
    ownerTeam = await createTeam(t.db, NOW, {
      gameId,
      userId: owner.userId,
      name: "Owner Racing",
    });
    rivalTeam = await createTeam(t.db, NOW, {
      gameId,
      userId: rival.userId,
      name: "Rival Racing",
    });
  });

  afterEach(async () => {
    await t.close();
  });

  const rows = (userId: string) =>
    t.db.select().from(notifications).where(eq(notifications.userId, userId));

  it("a team joining tells the league's owner", async () => {
    const { joinCode } = await createLeague(t.db, NOW, {
      gameId,
      ownerUserId: owner.userId,
      kind: "private",
      name: "Friends",
    });
    await joinLeague(t.db, NOW, {
      joinCode: joinCode!,
      teamId: ownerTeam,
      userId: owner.userId,
    });
    expect(await rows(owner.userId)).toHaveLength(0); // their own join
    await joinLeague(t.db, NOW, {
      joinCode: joinCode!,
      teamId: rivalTeam,
      userId: rival.userId,
    });
    const [item] = await inbox(t.db, NOW, owner);
    expect(item).toMatchObject({
      label: "LEAGUES",
      text: "Rival Racing joined Friends.",
      href: expect.stringMatching(/^\/leagues\/.+/),
    });
  });

  it("planning queues the reminders a day and an hour before the lock", async () => {
    const [event] = await t.db
      .select({ lockAt: events.lockAt })
      .from(events)
      .where(eq(events.id, firstEventId));
    await planGameJobs(t.db, NOW, gameId);
    for (const hours of [24, 1] as const) {
      const [job] = await t.db
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.kind, "lock_reminder"),
            eq(jobs.dedupeKey, lockReminderKey(gameId, firstEventId, hours)),
          ),
        );
      expect(job?.runAt).toEqual(
        new Date(event!.lockAt.getTime() - hours * HOUR),
      );
    }
  });

  it("each owner gets one reminder; the hour's counts into the day's", async () => {
    await createTeam(t.db, NOW, {
      gameId,
      userId: owner.userId,
      name: "Owner Two",
      slot: 2,
    });
    const [event] = await t.db
      .select({ lockAt: events.lockAt, name: events.name })
      .from(events)
      .where(eq(events.id, firstEventId));
    const before = (h: number) => new Date(event!.lockAt.getTime() - h * HOUR);

    expect(
      await remindLock(t.db, before(24), {
        gameId,
        eventId: firstEventId,
        hours: 24,
      }),
    ).toBe(2);
    expect(await rows(owner.userId)).toHaveLength(1);
    const [day] = await inbox(t.db, before(24), owner);
    expect(day!.text).toBe(
      `${event!.name} locks in 24 hours. Check your team.`,
    );

    await remindLock(t.db, before(1), {
      gameId,
      eventId: firstEventId,
      hours: 1,
    });
    expect(await rows(owner.userId)).toHaveLength(1);
    const [hour] = await inbox(t.db, before(1), owner);
    expect(hour!.text).toBe(`${event!.name} locks in 1 hour. Check your team.`);
  });

  it("the lock reminder writes owners in batches of 500, one transaction each, and a second run writes none twice", async () => {
    for (const n of [1, 2, 3]) {
      const fan = await seedViewer(t.db, { username: `fan${n}` });
      await createTeam(t.db, NOW, {
        gameId,
        userId: fan.userId,
        name: `Fan Racing ${n}`,
      });
    }
    const [event] = await t.db
      .select({ lockAt: events.lockAt })
      .from(events)
      .where(eq(events.id, firstEventId));
    const at = new Date(event!.lockAt.getTime() - 24 * HOUR);
    const key = lockReminderKey(gameId, firstEventId, 24);
    const remind = (dedupeKey: string) =>
      enqueue(t.db, {
        kind: "lock_reminder",
        dedupeKey,
        runAt: at,
        payload: { gameId, eventId: firstEventId, hours: 24 },
      });
    const run = () =>
      runDue(
        t.db,
        simulatedClock(at),
        { lock_reminder: createLockReminderHandler({ batch: 2 }) },
        { maxJobs: 20, leaseMs: 60_000 },
      );

    await remind(key);
    await run();
    // Five owners, two at a time: three jobs, each its own transaction.
    const chain = await t.db
      .select({ key: jobs.dedupeKey, status: jobs.status })
      .from(jobs)
      .where(eq(jobs.kind, "lock_reminder"));
    expect(chain.map((j) => j.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect(chain.filter((j) => j.key.startsWith(`${key}:after:`))).toHaveLength(
      2,
    );
    const all = () =>
      t.db
        .select()
        .from(notifications)
        .where(eq(notifications.kind, "lock_reminder"));
    expect((await all()).map((r) => r.count)).toEqual([1, 1, 1, 1, 1]);

    // The same reminder again (a sweep, a retry) writes nobody twice.
    await remind(`${key}:again`);
    await run();
    expect((await all()).map((r) => r.count)).toEqual([1, 1, 1, 1, 1]);
    expect(LOCK_REMINDER_BATCH).toBe(500);
  });

  it("no reminder once the lock has passed", async () => {
    const [event] = await t.db
      .select({ lockAt: events.lockAt })
      .from(events)
      .where(eq(events.id, firstEventId));
    expect(
      await remindLock(t.db, new Date(event!.lockAt.getTime() + 1000), {
        gameId,
        eventId: firstEventId,
        hours: 1,
      }),
    ).toBe(0);
  });
});
