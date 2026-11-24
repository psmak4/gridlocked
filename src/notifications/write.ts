/**
 * Writing notifications (DM 5.11). `notify` writes one person's row, or
 * counts it into their unread row with the same `group_key` ("5 new replies
 * in …"); `broadcast` writes one row for everyone. Both run inside the
 * caller's transaction, so a notification commits with what it is about.
 */
import { and, eq, sql } from "drizzle-orm";
import {
  broadcasts,
  notificationPreferences,
  notifications,
  profiles,
  pushSubscriptions,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { SYSTEM_USER_ID } from "@/identity/system";
import { pushBroadcastKey, pushNotificationKey } from "@/jobs/kinds";
import { enqueue } from "@/jobs/queue";
import { newId } from "@/lib/ids";
import type {
  BroadcastKind,
  NotificationChannel,
  NotificationKind,
} from "./kinds";
import type { NotificationData } from "./text";

/** What a notification is about: each a foreign key, all optional. */
export type NotificationRefs = {
  threadId?: string | null;
  postId?: string | null;
  eventId?: string | null;
  /** Makes it spoiler-scoped: its text is safe until the session is revealed. */
  sessionId?: string | null;
  leagueId?: string | null;
  teamId?: string | null;
};

export type NotifyInput = {
  userId: string;
  kind: NotificationKind;
  groupKey?: string | null;
  actorUserId?: string | null;
  refs?: NotificationRefs;
  data?: NotificationData;
};

/**
 * Each kind's default, by channel; a person's `notification_preferences` row
 * overrides it. Push defaults follow the opt-in sheet (wave 4): replies and
 * mentions start off.
 */
export const DEFAULT_PREFERENCES: Record<
  NotificationKind | BroadcastKind,
  Record<NotificationChannel, boolean>
> = {
  reply: { in_app: true, push: false },
  mention: { in_app: true, push: false },
  roster_change: { in_app: true, push: true },
  lock_reminder: { in_app: true, push: true },
  league_activity: { in_app: true, push: false },
  score_correction: { in_app: true, push: true },
  moderation: { in_app: true, push: false },
  usage_high: { in_app: true, push: true },
  scores_in: { in_app: true, push: true },
  announcement: { in_app: true, push: false },
};

/** Whether the person has this kind on for the channel. */
export async function wants(
  db: Db,
  userId: string,
  kind: NotificationKind | BroadcastKind,
  channel: NotificationChannel,
): Promise<boolean> {
  const [row] = await db
    .select({ enabled: notificationPreferences.enabled })
    .from(notificationPreferences)
    .where(
      and(
        eq(notificationPreferences.userId, userId),
        eq(notificationPreferences.kind, kind),
        eq(notificationPreferences.channel, channel),
      ),
    );
  return row ? row.enabled : DEFAULT_PREFERENCES[kind][channel];
}

/**
 * Writes or counts one notification. Nothing for the actor themself, the
 * system account, a deleted account, or a kind the person turned off. Returns the row's id,
 * or null when nothing was written.
 */
export async function notify(
  db: Db,
  now: Date,
  input: NotifyInput,
): Promise<string | null> {
  if (input.userId === SYSTEM_USER_ID) return null;
  if (input.actorUserId && input.actorUserId === input.userId) return null;
  const [profile] = await db
    .select({ status: profiles.status })
    .from(profiles)
    .where(eq(profiles.userId, input.userId));
  if (!profile || profile.status === "deleted") return null;
  if (!(await wants(db, input.userId, input.kind, "in_app"))) return null;

  const refs = input.refs ?? {};
  const values = {
    id: newId(),
    userId: input.userId,
    kind: input.kind,
    groupKey: input.groupKey ?? null,
    actorUserId: input.actorUserId ?? null,
    threadId: refs.threadId ?? null,
    postId: refs.postId ?? null,
    eventId: refs.eventId ?? null,
    sessionId: refs.sessionId ?? null,
    leagueId: refs.leagueId ?? null,
    teamId: refs.teamId ?? null,
    data: input.data ?? {},
    createdAt: now,
  };
  if (!input.groupKey) {
    await db.insert(notifications).values(values);
    await queuePush(db, now, input.userId, values.id);
    return values.id;
  }
  // One unread row per group: a new one counts into it and moves it to the top.
  const [row] = await db
    .insert(notifications)
    .values(values)
    .onConflictDoUpdate({
      target: [notifications.userId, notifications.groupKey],
      targetWhere: sql`${notifications.readAt} is null and ${notifications.groupKey} is not null`,
      set: {
        count: sql`${notifications.count} + 1`,
        actorUserId: sql`excluded.actor_user_id`,
        postId: sql`excluded.post_id`,
        data: sql`excluded.data`,
        createdAt: sql`excluded.created_at`,
      },
    })
    .returning({ id: notifications.id });
  await queuePush(db, now, input.userId, row!.id);
  return row!.id;
}

/**
 * A `push_fanout` job for a notification, if its person has a device: the
 * job decides the rest (their push setting, the keys), outside this
 * transaction's hurry.
 */
async function queuePush(
  db: Db,
  now: Date,
  userId: string,
  notificationId: string,
): Promise<void> {
  const [device] = await db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId))
    .limit(1);
  if (!device) return;
  await enqueue(db, {
    kind: "push_fanout",
    dedupeKey: pushNotificationKey(notificationId, now),
    runAt: now,
    payload: { notificationIds: [notificationId] },
  });
}

export type BroadcastInput = {
  gameId?: string | null;
  kind: BroadcastKind;
  sessionId?: string | null;
  eventId?: string | null;
  /** Once only: a second broadcast with the key writes nothing. */
  dedupeKey?: string | null;
  data?: NotificationData;
};

/** One row for everyone. Returns its id, or null for a repeat. */
export async function broadcast(
  db: Db,
  now: Date,
  input: BroadcastInput,
): Promise<string | null> {
  const id = newId();
  const written = await db
    .insert(broadcasts)
    .values({
      id,
      gameId: input.gameId ?? null,
      kind: input.kind,
      sessionId: input.sessionId ?? null,
      eventId: input.eventId ?? null,
      dedupeKey: input.dedupeKey ?? null,
      data: input.data ?? {},
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: broadcasts.id });
  if (written.length === 0) return null;
  // Its push, if anyone has a device at all.
  const [device] = await db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .limit(1);
  if (!device) return id;
  await enqueue(db, {
    kind: "push_fanout",
    dedupeKey: pushBroadcastKey(id),
    runAt: now,
    payload: { broadcastId: id },
  });
  return id;
}
