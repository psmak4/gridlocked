/**
 * Reading notifications (wave 4's Notifications board): one person's rows
 * and everyone's broadcasts, newest first, from the last 90 days (DM 5.10).
 * The words are made here, per reader, so a row tied to a session the reader
 * hasn't revealed reads in its spoiler-safe form.
 */
import { and, count, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { broadcasts, notifications, profiles, users } from "@/db/schema";
import type { Db } from "@/db/types";
import type { Viewer } from "@/identity/viewer";
import { dayTimeLabel, zoneOrUtc } from "@/lib/settings-words";
import { isRevealed, revealedSessions } from "@/spoilers/reveal";
import { readerOf } from "@/play/weekend";
import type { AnyNotificationKind, NotificationData } from "./text";
import { notificationText } from "./text";

export const NOTIFICATION_DAYS = 90;
const DAY_MS = 86_400_000;
const INBOX_LIMIT = 100;

export type InboxItem = {
  id: string;
  source: "personal" | "broadcast";
  kind: AnyNotificationKind;
  label: string;
  text: string;
  href: string;
  createdAt: string;
  /** "8 Jun, 22:02": when, in the reader's own zone. */
  time: string;
  unread: boolean;
};

type Linkable = {
  kind: AnyNotificationKind;
  threadId?: string | null;
  postId?: string | null;
  data: NotificationData;
};

/** Where a notification goes when it's opened. */
export function notificationHref(n: Linkable): string {
  switch (n.kind) {
    case "reply":
    case "mention":
      if (!n.threadId) return "/forum";
      return n.postId
        ? `/t/${n.threadId}#post-${n.postId}`
        : `/t/${n.threadId}`;
    case "roster_change":
    case "lock_reminder":
    case "score_correction":
      return "/team";
    case "league_activity":
      return n.data.leagueSlug ? `/leagues/${n.data.leagueSlug}` : "/leagues";
    case "moderation":
      return "/profile";
    case "scores_in":
      return "/weekend";
    case "announcement":
      return "/";
  }
}

/** The day the list starts: 90 days back, or when the account was made. */
/** The start of the 90 days the list keeps. */
const windowStart = (now: Date) =>
  new Date(now.getTime() - NOTIFICATION_DAYS * DAY_MS);

/**
 * Where broadcasts start for someone: the 90 days, or their join date if
 * later, so nobody new gets the season's old news. Their own rows need no
 * such bound (nothing personal predates the account), and a replay clock
 * runs behind the wall clock an account is created on.
 */
async function broadcastsSince(
  db: Db,
  now: Date,
  userId: string,
): Promise<Date> {
  const [user] = await db
    .select({ createdAt: users.createdAt })
    .from(users)
    .where(eq(users.id, userId));
  const window = windowStart(now);
  return user && user.createdAt > window ? user.createdAt : window;
}

/** The person's notifications and the broadcasts, merged, newest first. */
export async function inbox(
  db: Db,
  now: Date,
  viewer: Viewer,
): Promise<InboxItem[]> {
  const from = windowStart(now);
  const joined = await broadcastsSince(db, now, viewer.userId);
  const personal = await db
    .select({
      id: notifications.id,
      kind: notifications.kind,
      count: notifications.count,
      threadId: notifications.threadId,
      postId: notifications.postId,
      sessionId: notifications.sessionId,
      data: notifications.data,
      createdAt: notifications.createdAt,
      readAt: notifications.readAt,
      actor: sql<
        string | null
      >`coalesce(${users.displayUsername}, ${users.username})`,
    })
    .from(notifications)
    .leftJoin(users, eq(users.id, notifications.actorUserId))
    .where(
      and(
        eq(notifications.userId, viewer.userId),
        gt(notifications.createdAt, from),
      ),
    )
    .orderBy(desc(notifications.createdAt))
    .limit(INBOX_LIMIT);
  const everyone = await db
    .select()
    .from(broadcasts)
    .where(gt(broadcasts.createdAt, joined))
    .orderBy(desc(broadcasts.createdAt))
    .limit(INBOX_LIMIT);
  const [profile] = await db
    .select({ readAt: profiles.broadcastsReadAt })
    .from(profiles)
    .where(eq(profiles.userId, viewer.userId));
  const broadcastsReadAt = profile?.readAt ?? null;

  const revealed = await revealedSessions(db, now, readerOf(viewer), [
    ...personal.flatMap((n) => (n.sessionId ? [n.sessionId] : [])),
    ...everyone.flatMap((b) => (b.sessionId ? [b.sessionId] : [])),
  ]);
  const shown = (sessionId: string | null) =>
    sessionId === null || revealed.has(sessionId);
  const zone = zoneOrUtc(viewer.profile.timezone);
  const protection = viewer.profile.spoilerProtection;
  // A spoiler thread with no session: hidden through the window after it
  // started, as the forum hides it.
  const personalShown = (sessionId: string | null, d: NotificationData) =>
    sessionId !== null || !d.spoilerSince
      ? shown(sessionId)
      : isRevealed({
          sessionStart: new Date(d.spoilerSince),
          now,
          watched: false,
          protection,
        });

  const items: InboxItem[] = [
    ...personal.map((n): InboxItem => {
      const data: NotificationData = {
        ...(n.data as NotificationData),
        count: n.count,
        actor: n.actor,
      };
      const line = notificationText(
        n.kind,
        data,
        personalShown(n.sessionId, data),
        zone,
      );
      return {
        id: n.id,
        source: "personal",
        kind: n.kind,
        ...line,
        href: notificationHref({ ...n, data }),
        createdAt: n.createdAt.toISOString(),
        time: dayTimeLabel(n.createdAt, zone),
        unread: n.readAt === null,
      };
    }),
    ...everyone.map((b): InboxItem => {
      const data = b.data as NotificationData;
      const line = notificationText(b.kind, data, shown(b.sessionId), zone);
      return {
        id: b.id,
        source: "broadcast",
        kind: b.kind,
        ...line,
        href: notificationHref({ kind: b.kind, data }),
        createdAt: b.createdAt.toISOString(),
        time: dayTimeLabel(b.createdAt, zone),
        unread: broadcastsReadAt === null || b.createdAt > broadcastsReadAt,
      };
    }),
  ];
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return items.slice(0, INBOX_LIMIT);
}

export type MarkReadInput = { ids: string[] } | { all: true };

/**
 * Marks the person's own rows read: some, or all of them and every broadcast
 * so far. A broadcast id in `ids` marks the broadcasts up to it read.
 */
export async function markRead(
  db: Db,
  now: Date,
  viewer: Viewer,
  input: MarkReadInput,
): Promise<void> {
  if ("all" in input) {
    await db
      .update(notifications)
      .set({ readAt: now })
      .where(
        and(
          eq(notifications.userId, viewer.userId),
          isNull(notifications.readAt),
        ),
      );
    await db
      .update(profiles)
      .set({ broadcastsReadAt: now })
      .where(eq(profiles.userId, viewer.userId));
    return;
  }
  if (input.ids.length === 0) return;
  await db
    .update(notifications)
    .set({ readAt: now })
    .where(
      and(
        eq(notifications.userId, viewer.userId),
        inArray(notifications.id, input.ids),
        isNull(notifications.readAt),
      ),
    );
  const [latest] = await db
    .select({ createdAt: broadcasts.createdAt })
    .from(broadcasts)
    .where(inArray(broadcasts.id, input.ids))
    .orderBy(desc(broadcasts.createdAt))
    .limit(1);
  if (!latest) return;
  const [profile] = await db
    .select({ readAt: profiles.broadcastsReadAt })
    .from(profiles)
    .where(eq(profiles.userId, viewer.userId));
  if (profile?.readAt && profile.readAt >= latest.createdAt) return;
  await db
    .update(profiles)
    .set({ broadcastsReadAt: latest.createdAt })
    .where(eq(profiles.userId, viewer.userId));
}

/** The number on the bell: unread rows plus unread broadcasts. */
export async function unreadCount(
  db: Db,
  now: Date,
  viewer: Viewer,
): Promise<number> {
  const from = windowStart(now);
  const joined = await broadcastsSince(db, now, viewer.userId);
  const [mine] = await db
    .select({ n: count() })
    .from(notifications)
    .where(
      and(
        eq(notifications.userId, viewer.userId),
        isNull(notifications.readAt),
        gt(notifications.createdAt, from),
      ),
    );
  const [profile] = await db
    .select({ readAt: profiles.broadcastsReadAt })
    .from(profiles)
    .where(eq(profiles.userId, viewer.userId));
  const readAt = profile?.readAt;
  const after = readAt && readAt > joined ? readAt : joined;
  const [theirs] = await db
    .select({ n: count() })
    .from(broadcasts)
    .where(gt(broadcasts.createdAt, after));
  return Number(mine?.n ?? 0) + Number(theirs?.n ?? 0);
}
