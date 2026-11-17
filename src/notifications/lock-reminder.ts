/**
 * `lock_reminder`: "<event> locks in 24 hours. Check your team." to everyone
 * with an active team in the game (wave 4: LOCK). One row per person, however
 * many teams they have; the hour's reminder counts into the day's if that one
 * is still unread. Nothing once the lock has passed or the event has locked.
 */
import { and, asc, eq } from "drizzle-orm";
import { events, gameEvents, teams } from "@/db/schema";
import type { Db } from "@/db/types";
import { lockReminderPayload } from "@/jobs/kinds";
import type { JobHandler } from "@/jobs/runner";
import { notify } from "./write";

export async function remindLock(
  db: Db,
  now: Date,
  input: { gameId: string; eventId: string; hours: 24 | 1 },
): Promise<number> {
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
  if (!event) return 0;
  if (event.status !== "upcoming" && event.status !== "open") return 0;
  if (event.lockAt.getTime() <= now.getTime()) return 0;

  const owners = await db
    .select({ userId: teams.userId, teamId: teams.id })
    .from(teams)
    .where(and(eq(teams.gameId, input.gameId), eq(teams.status, "active")))
    .orderBy(asc(teams.userId), asc(teams.slot));
  const seen = new Set<string>();
  let written = 0;
  for (const owner of owners) {
    if (seen.has(owner.userId)) continue;
    seen.add(owner.userId);
    const id = await notify(db, now, {
      userId: owner.userId,
      kind: "lock_reminder",
      groupKey: `lock:${input.eventId}`,
      refs: { eventId: input.eventId, teamId: owner.teamId },
      data: { event: event.name, hours: input.hours },
    });
    if (id) written += 1;
  }
  return written;
}

export function createLockReminderHandler(): JobHandler {
  return async (job, ctx) => {
    const payload = lockReminderPayload.parse(job.payload);
    await ctx.db.transaction(async (tx) => {
      await remindLock(tx as unknown as Db, ctx.clock.now(), payload);
    });
  };
}
