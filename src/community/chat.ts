/**
 * Live session chat (HLD §7.2, DM 5.5): short plain-text messages in a
 * session thread while it is in chat mode, apart from posts. Everyone in a
 * thread refreshes the same URL each window (src/server/chat-refresh.ts), so
 * a read here never depends on who is asking.
 */
import { and, asc, desc, eq, gt, lt, sql, type SQL } from "drizzle-orm";
import { chatMessages, profiles, sessions, threads, users } from "@/db/schema";
import type { Db } from "@/db/types";
import { canPost, type Viewer } from "@/identity/viewer";
import { newId } from "@/lib/ids";
import { getSetting } from "@/settings";
import { refuse, type CommunityRefusal } from "./errors";
import { checkPost, effectiveLevel } from "./gate";
import { queueFilterHits } from "./moderation";
import { DELETED_USER } from "./read";
import { threadMode } from "./session-threads";

/** One chat message, as every viewer sees it. */
export type ChatMessageView = {
  id: string;
  author: string;
  body: string;
  /** ISO 8601. */
  createdAt: string;
};

export type SendChatResult =
  { ok: true; message: ChatMessageView } | CommunityRefusal;

/** How many messages a refresh or the history returns at most. */
export const CHAT_PAGE = 50;

const viewColumns = {
  id: chatMessages.id,
  body: chatMessages.body,
  createdAt: chatMessages.createdAt,
  username: users.username,
  displayUsername: users.displayUsername,
  profileStatus: profiles.status,
};

type ViewRow = {
  id: string;
  body: string;
  createdAt: Date;
  username: string | null;
  displayUsername: string | null;
  profileStatus: string | null;
};

const toView = (row: ViewRow): ChatMessageView => ({
  id: row.id,
  author:
    row.profileStatus === "deleted"
      ? DELETED_USER
      : (row.displayUsername ?? row.username ?? DELETED_USER),
  body: row.body,
  createdAt: row.createdAt.toISOString(),
});

/** Visible messages in a thread, with their authors' names. */
function visibleIn(db: Db, threadId: string, extra: SQL | undefined) {
  return db
    .select(viewColumns)
    .from(chatMessages)
    .leftJoin(users, eq(users.id, chatMessages.authorUserId))
    .leftJoin(profiles, eq(profiles.userId, chatMessages.authorUserId))
    .where(
      and(
        eq(chatMessages.threadId, threadId),
        eq(chatMessages.status, "visible"),
        extra,
      ),
    );
}

/**
 * A thread's visible messages after `afterId` (all of them from the start
 * when null), oldest first. The UUIDv7 id is the order, so two messages in
 * the same millisecond still come back in the order they were made.
 */
export async function chatSince(
  db: Db,
  threadId: string,
  afterId: string | null,
  limit = CHAT_PAGE,
): Promise<ChatMessageView[]> {
  const rows = await visibleIn(
    db,
    threadId,
    afterId ? gt(chatMessages.id, afterId) : undefined,
  )
    .orderBy(asc(chatMessages.id))
    .limit(limit);
  return rows.map(toView);
}

/**
 * The latest `limit` visible messages made before `end`, oldest first: what
 * a refresh window shows. A removed message is simply not there.
 */
export async function chatUpTo(
  db: Db,
  threadId: string,
  end: Date,
  limit = CHAT_PAGE,
): Promise<ChatMessageView[]> {
  const rows = await visibleIn(db, threadId, lt(chatMessages.createdAt, end))
    .orderBy(desc(chatMessages.id))
    .limit(limit);
  return rows.reverse().map(toView);
}

/** The thread's chat window and its session's status, or null. */
export async function chatState(db: Db, threadId: string) {
  const [row] = await db
    .select({
      kind: threads.kind,
      status: threads.status,
      sessionId: threads.sessionId,
      chatOpensAt: threads.chatOpensAt,
      chatClosesAt: threads.chatClosesAt,
      slowMode: threads.slowModeSeconds,
      sessionStatus: sessions.status,
    })
    .from(threads)
    .leftJoin(sessions, eq(sessions.id, threads.sessionId))
    .where(eq(threads.id, threadId));
  return row ?? null;
}

type ChatState = NonNullable<Awaited<ReturnType<typeof chatState>>>;

const modeOf = (now: Date, s: ChatState) =>
  threadMode(now, s.sessionStatus ? { status: s.sessionStatus } : null, s);

/**
 * Sends a chat message. The gate covers restrictions, trust, length, links,
 * filters and slow mode; the insert then re-checks the window and slow mode
 * under a per-person lock, so two sends at once can't both slip through.
 */
export async function sendChat(
  db: Db,
  now: Date,
  viewer: Viewer | null,
  input: { threadId: string; body: string },
): Promise<SendChatResult> {
  const v = canPost(viewer);
  const body = input.body.trim();
  if (body.length === 0) return refuse("too_long");
  const state = await chatState(db, input.threadId);
  if (!state || state.status === "removed") return refuse("not_found");
  if (modeOf(now, state) !== "chat") return refuse("chat_closed");

  const gate = await checkPost(db, now, v, {
    kind: "chat",
    threadId: input.threadId,
    body,
  });
  if (!gate.ok) return gate;
  // Chat has no review queue: what a filter would hold isn't sent.
  if (gate.hold) return refuse("blocked");

  const slow = await slowModeFor(db, v, state.slowMode);

  return db.transaction(async (tx): Promise<SendChatResult> => {
    const t = tx as unknown as Db;
    await t.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`chat:${input.threadId}:${v.userId}`}, 0))`,
    );
    const fresh = await chatState(t, input.threadId);
    if (!fresh || fresh.status !== "open") return refuse("thread_locked");
    if (modeOf(now, fresh) !== "chat") return refuse("chat_closed");
    if (slow > 0) {
      const [last] = await t
        .select({ createdAt: chatMessages.createdAt })
        .from(chatMessages)
        .where(
          and(
            eq(chatMessages.threadId, input.threadId),
            eq(chatMessages.authorUserId, v.userId),
          ),
        )
        .orderBy(desc(chatMessages.createdAt))
        .limit(1);
      if (last) {
        const nextAt = last.createdAt.getTime() + slow * 1000;
        if (nextAt > now.getTime()) {
          return refuse(
            "slow_mode",
            Math.max(1, Math.ceil((nextAt - now.getTime()) / 1000)),
          );
        }
      }
    }
    const id = newId();
    await t.insert(chatMessages).values({
      id,
      threadId: input.threadId,
      sessionId: fresh.sessionId,
      authorUserId: v.userId,
      body,
      status: "visible",
      createdAt: now,
    });
    // A flag doesn't stop a message; it queues it for a look.
    await queueFilterHits(
      t,
      now,
      {
        type: "chat_message",
        id,
        authorUserId: v.userId,
        threadId: input.threadId,
        body,
      },
      gate.flags,
    );
    const [me] = await t
      .select({
        username: users.username,
        displayUsername: users.displayUsername,
        profileStatus: profiles.status,
      })
      .from(users)
      .leftJoin(profiles, eq(profiles.userId, users.id))
      .where(eq(users.id, v.userId));
    return {
      ok: true,
      message: toView({
        id,
        body,
        createdAt: now,
        username: me?.username ?? null,
        displayUsername: me?.displayUsername ?? null,
        profileStatus: me?.profileStatus ?? null,
      }),
    };
  });
}

/** How long `viewer` waits between messages in this thread, in seconds. */
export async function slowModeFor(
  db: Db,
  viewer: Viewer,
  threadSlowMode: number | null,
): Promise<number> {
  const [limits, profile] = await Promise.all([
    getSetting(db, "chat_limits"),
    db
      .select({ trustLevel: profiles.trustLevel })
      .from(profiles)
      .where(eq(profiles.userId, viewer.userId)),
  ]);
  const level = effectiveLevel(viewer, profile[0]?.trustLevel ?? 0);
  const tier = (["tl0", "tl1", "tl2", "tl3"] as const)[
    Math.max(0, Math.min(3, level))
  ]!;
  return Math.max(limits.slowModeSeconds[tier], threadSlowMode ?? 0);
}
