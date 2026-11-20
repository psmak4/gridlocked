/**
 * Web Push (DM 5.11, decision 4): the browsers someone turned push on for,
 * and the `push_fanout` job that sends to them. A payload is always the
 * spoiler-safe words — a lock screen can't know what its reader has seen.
 * At most 100 sends a job (DM 2.10); a 404 or 410 deletes the subscription,
 * and any other failure counts up on it.
 */
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import {
  broadcasts,
  notifications,
  pushSubscriptions,
  users,
} from "@/db/schema";
import type { Db } from "@/db/types";
import type { Viewer } from "@/identity/viewer";
import { newId } from "@/lib/ids";
import {
  pushBroadcastKey,
  pushFanoutPayload,
  type PushFanoutPayload,
} from "@/jobs/kinds";
import { enqueue } from "@/jobs/queue";
import type { JobHandler } from "@/jobs/runner";
import { notificationHref } from "./read";
import { notificationText, type NotificationData } from "./text";
import { wants } from "./write";

/** Sends per job. */
export const PUSH_BATCH = 100;

export type PushTarget = { endpoint: string; p256dh: string; auth: string };
export type PushResult = { ok: true } | { ok: false; status: number | null };

/** The push service. `web-push` in the function; a fake in tests. */
export interface PushSender {
  send(target: PushTarget, payload: string): Promise<PushResult>;
}

/** What the service worker shows. */
export type PushPayload = {
  title: string;
  body: string;
  url: string;
  /** One on-screen notification per tag: a newer one replaces it. */
  tag: string;
};

export type SubscribeInput = {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
};

/** The most devices one account pushes to; a new one drops the oldest. */
export const MAX_DEVICES = 10;

/**
 * Keeps a browser's subscription. The same endpoint again (a new key, or
 * someone else signed in on that browser) replaces the row. An account keeps
 * its `MAX_DEVICES` newest, so one account can't multiply every broadcast.
 */
export async function subscribe(
  db: Db,
  now: Date,
  viewer: Viewer,
  input: SubscribeInput,
): Promise<void> {
  await db
    .insert(pushSubscriptions)
    .values({
      id: newId(),
      userId: viewer.userId,
      endpoint: input.endpoint,
      p256dh: input.p256dh,
      auth: input.auth,
      userAgent: input.userAgent ?? null,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: {
        userId: viewer.userId,
        p256dh: input.p256dh,
        auth: input.auth,
        userAgent: input.userAgent ?? null,
        createdAt: now,
        failureCount: 0,
      },
    });
  await db.execute(sql`
    delete from ${pushSubscriptions}
    where ${pushSubscriptions.userId} = ${viewer.userId}
      and ${pushSubscriptions.id} not in (
        select ${pushSubscriptions.id} from ${pushSubscriptions}
        where ${pushSubscriptions.userId} = ${viewer.userId}
        order by ${pushSubscriptions.createdAt} desc, ${pushSubscriptions.id} desc
        limit ${MAX_DEVICES}
      )`);
}

/** Turns push off for this browser: only the viewer's own row goes. */
export async function unsubscribe(
  db: Db,
  viewer: Viewer,
  input: { endpoint: string },
): Promise<void> {
  await db
    .delete(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.endpoint, input.endpoint),
        eq(pushSubscriptions.userId, viewer.userId),
      ),
    );
}

/** Whether the person has any device to push to. */
export async function hasDevice(db: Db, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: pushSubscriptions.id })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId))
    .limit(1);
  return row !== undefined;
}

type Subscription = typeof pushSubscriptions.$inferSelect;
type Send = { sub: Subscription; payload: PushPayload };

export type FanOutResult = {
  sent: number;
  removed: number;
  failed: number;
  /** Not sent: no VAPID keys. */
  skipped: number;
  /** A broadcast's next page starts after this subscription id. */
  next?: string;
};

/** Personal notifications: each to every device of its person who wants it. */
async function personalSends(db: Db, ids: string[]): Promise<Send[]> {
  const rows = await db
    .select({
      id: notifications.id,
      userId: notifications.userId,
      kind: notifications.kind,
      count: notifications.count,
      threadId: notifications.threadId,
      postId: notifications.postId,
      data: notifications.data,
      actor: sql<
        string | null
      >`coalesce(${users.displayUsername}, ${users.username})`,
    })
    .from(notifications)
    .leftJoin(users, eq(users.id, notifications.actorUserId))
    .where(inArray(notifications.id, ids));
  const sends: Send[] = [];
  for (const n of rows) {
    if (!(await wants(db, n.userId, n.kind, "push"))) continue;
    const data: NotificationData = {
      ...(n.data as NotificationData),
      count: n.count,
      actor: n.actor,
    };
    const line = notificationText(n.kind, data, false);
    const payload: PushPayload = {
      title: line.label,
      body: line.text,
      url: notificationHref({ ...n, data }),
      tag: n.id,
    };
    const subs = await db
      .select()
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, n.userId))
      .orderBy(asc(pushSubscriptions.id));
    for (const sub of subs) sends.push({ sub, payload });
  }
  return sends;
}

/** One page of a broadcast: the next 100 subscriptions, minus those who opted out. */
async function broadcastSends(
  db: Db,
  broadcastId: string,
  afterId: string | undefined,
): Promise<{ sends: Send[]; next?: string }> {
  const [b] = await db
    .select()
    .from(broadcasts)
    .where(eq(broadcasts.id, broadcastId));
  if (!b) return { sends: [] };
  const line = notificationText(b.kind, b.data as NotificationData, false);
  const payload: PushPayload = {
    title: line.label,
    body: line.text,
    url: notificationHref({ kind: b.kind, data: b.data as NotificationData }),
    tag: b.id,
  };
  const page = await db
    .select()
    .from(pushSubscriptions)
    .where(afterId ? gt(pushSubscriptions.id, afterId) : undefined)
    .orderBy(asc(pushSubscriptions.id))
    .limit(PUSH_BATCH);
  const decided = new Map<string, boolean>();
  const sends: Send[] = [];
  for (const sub of page) {
    let yes = decided.get(sub.userId);
    if (yes === undefined) {
      yes = await wants(db, sub.userId, b.kind, "push");
      decided.set(sub.userId, yes);
    }
    if (yes) sends.push({ sub, payload });
  }
  const next = page.length === PUSH_BATCH ? page.at(-1)!.id : undefined;
  return { sends, next };
}

/**
 * Sends one batch. With no sender (no VAPID keys) it sends nothing and says
 * how many it skipped.
 */
export async function fanOut(
  db: Db,
  sender: PushSender | null,
  now: Date,
  input: PushFanoutPayload,
  options: { log?: (line: string) => void } = {},
): Promise<FanOutResult> {
  const { sends, next } =
    "notificationIds" in input
      ? { sends: await personalSends(db, input.notificationIds) }
      : await broadcastSends(db, input.broadcastId, input.afterId);
  const result: FanOutResult = { sent: 0, removed: 0, failed: 0, skipped: 0 };
  if (next) result.next = next;
  if (!sender) {
    result.skipped = sends.length;
    if (sends.length > 0)
      (options.log ?? console.log)(
        `push: no VAPID keys, ${sends.length} sends skipped`,
      );
    return result;
  }
  for (const { sub, payload } of sends.slice(0, PUSH_BATCH)) {
    let answer: PushResult;
    try {
      answer = await sender.send(
        { endpoint: sub.endpoint, p256dh: sub.p256dh, auth: sub.auth },
        JSON.stringify(payload),
      );
    } catch {
      answer = { ok: false, status: null };
    }
    if (answer.ok) {
      result.sent += 1;
      await db
        .update(pushSubscriptions)
        .set({ lastSuccessAt: now, failureCount: 0 })
        .where(eq(pushSubscriptions.id, sub.id));
    } else if (answer.status === 404 || answer.status === 410) {
      result.removed += 1;
      await db
        .delete(pushSubscriptions)
        .where(eq(pushSubscriptions.id, sub.id));
    } else {
      result.failed += 1;
      await db
        .update(pushSubscriptions)
        .set({ failureCount: sql`${pushSubscriptions.failureCount} + 1` })
        .where(eq(pushSubscriptions.id, sub.id));
    }
  }
  return result;
}

/** `push_fanout`: one batch, and a broadcast's next page as a job of its own. */
export function createPushFanoutHandler(sender: PushSender | null): JobHandler {
  return async (job, ctx) => {
    const payload = pushFanoutPayload.parse(job.payload);
    const db = ctx.db as Db;
    const now = ctx.clock.now();
    const done = await fanOut(db, sender, now, payload);
    if (done.next && "broadcastId" in payload) {
      await enqueue(db, {
        kind: "push_fanout",
        dedupeKey: pushBroadcastKey(payload.broadcastId, done.next),
        runAt: now,
        payload: { broadcastId: payload.broadcastId, afterId: done.next },
      });
    }
  };
}
