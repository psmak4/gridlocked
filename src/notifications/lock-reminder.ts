/**
 * `lock_reminder`: "<event> locks in 24 hours. Check your team." to everyone
 * with an active team in the game (wave 4: LOCK). One row per person, however
 * many teams they have; the hour's reminder counts into the day's if that one
 * is still unread. Nothing once the lock has passed or the event has locked.
 */
import { and, asc, eq, gt, notExists, sql } from "drizzle-orm";
import { events, gameEvents, notifications, teams } from "@/db/schema";
import type { Db } from "@/db/types";
import { lockReminderPayload, type LockReminderPayload } from "@/jobs/kinds";
import { enqueue } from "@/jobs/queue";
import type { JobHandler } from "@/jobs/runner";
import { notify } from "./write";

/** Owners a job writes at most, each job its own transaction (M9 Task 3). */
export const LOCK_REMINDER_BATCH = 500;

type Reminder = Pick<LockReminderPayload, "gameId" | "eventId" | "hours">;

/**
 * One batch: up to `batch` owners after `afterUserId`, in user id order,
 * leaving out anyone this reminder already reached (a retry, a sweep).
 * Returns how many it wrote and the last owner it looked at, or null when
 * there was nobody left.
 */
export async function remindLockBatch(
  db: Db,
  now: Date,
  input: Reminder & { afterUserId?: string },
  batch = LOCK_REMINDER_BATCH,
): Promise<{ written: number; lastUserId: string | null; full: boolean }> {
  const none = { written: 0, lastUserId: null, full: false };
  const [event] = await db
    .select({
      name: events.name,
      lockAt: events.lockAt,
      status: gameEvents.status,
    })
    .from(gameEvents)
    .innerJoin(events, eq(events.id, gameEvents.eventId))
    .where(
      and(
        eq(gameEvents.gameId, input.gameId),
        eq(gameEvents.eventId, input.eventId),
      ),
    );
  if (!event) return none;
  if (event.status !== "upcoming" && event.status !== "open") return none;
  if (event.lockAt.getTime() <= now.getTime()) return none;

  // One row per owner, their first team, however many they have.
  const owners = await db
    .selectDistinctOn([teams.userId], {
      userId: teams.userId,
      teamId: teams.id,
    })
    .from(teams)
    .where(
      and(
        eq(teams.gameId, input.gameId),
        eq(teams.status, "active"),
        input.afterUserId ? gt(teams.userId, input.afterUserId) : undefined,
        notExists(
          db
            .select({ one: sql`1` })
            .from(notifications)
            .where(
              and(
                eq(notifications.userId, teams.userId),
                eq(notifications.kind, "lock_reminder"),
                eq(notifications.eventId, input.eventId),
                sql`${notifications.data}->>'hours' = ${String(input.hours)}`,
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(teams.userId), asc(teams.slot))
    .limit(batch);
  let written = 0;
  for (const owner of owners) {
    const id = await notify(db, now, {
      userId: owner.userId,
      kind: "lock_reminder",
      groupKey: `lock:${input.eventId}`,
      refs: { eventId: input.eventId, teamId: owner.teamId },
      data: { event: event.name, hours: input.hours },
    });
    if (id) written += 1;
  }
  return {
    written,
    lastUserId: owners.at(-1)?.userId ?? null,
    full: owners.length === batch,
  };
}

/** Every batch in turn, in one go (tests and scripts). */
export async function remindLock(
  db: Db,
  now: Date,
  input: Reminder,
  batch = LOCK_REMINDER_BATCH,
): Promise<number> {
  let written = 0;
  let afterUserId: string | undefined;
  for (;;) {
    const step = await remindLockBatch(
      db,
      now,
      { ...input, afterUserId },
      batch,
    );
    written += step.written;
    if (!step.full || step.lastUserId === null) return written;
    afterUserId = step.lastUserId;
  }
}

/**
 * One batch a job. A full batch queues the next, in the same transaction,
 * keyed after its last owner under this run's own key, so the chain of one
 * run never meets another's.
 */
export function createLockReminderHandler(
  options: { batch?: number } = {},
): JobHandler {
  const batch = options.batch ?? LOCK_REMINDER_BATCH;
  return async (job, ctx) => {
    const payload = lockReminderPayload.parse(job.payload);
    const now = ctx.clock.now();
    const root = job.dedupeKey.split(":after:")[0]!;
    await ctx.db.transaction(async (tx) => {
      const db = tx as unknown as Db;
      const step = await remindLockBatch(db, now, payload, batch);
      if (!step.full || step.lastUserId === null) return;
      const next: LockReminderPayload = {
        gameId: payload.gameId,
        eventId: payload.eventId,
        hours: payload.hours,
        afterUserId: step.lastUserId,
      };
      await enqueue(db, {
        kind: "lock_reminder",
        dedupeKey: `${root}:after:${step.lastUserId}`,
        runAt: now,
        payload: next,
      });
    });
  };
}
