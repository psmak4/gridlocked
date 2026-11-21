/**
 * The chat archive (DM 5.5): 30 days after a session, its thread's visible
 * chat goes to one gzip JSON-lines file in the `chat-archives` bucket, and
 * the rows go. Each line keeps only the id, the author's id, the time and the
 * text. Removed messages aren't archived; a reported one is already kept in
 * its moderation queue item (DM 5.9), so archiving destroys no evidence.
 *
 * Every step is safe to run again: the file's key is the thread's, so a
 * second upload overwrites the first with the same lines, and the
 * `chat_archives` row and the delete commit together.
 */
import { gunzipSync, gzipSync } from "node:zlib";
import { and, asc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import {
  chatArchives,
  chatMessages,
  modQueueItems,
  profiles,
  reports,
  sessions,
  threads,
  users,
} from "@/db/schema";
import type { Db } from "@/db/types";
import type { ChatMessageView } from "./chat";
import { DELETED_USER } from "./read";

/** The port to the `chat-archives` bucket (decision 5). */
export interface ChatArchiveStore {
  put(key: string, body: Uint8Array): Promise<void>;
  /** Null when there is no such file. */
  get(key: string): Promise<Uint8Array | null>;
}

/** For wiring with no bucket: any use throws, so nothing is lost quietly. */
export const unconfiguredChatArchiveStore: ChatArchiveStore = {
  async put() {
    throw new Error("no chat archive store is configured");
  },
  async get() {
    throw new Error("no chat archive store is configured");
  },
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** A session's chat is archived this long after it ends (DM 5.5). */
export const ARCHIVE_AFTER_DAYS = 30;

/** One line of an archive file. */
export type ArchivedLine = {
  id: string;
  authorUserId: string;
  createdAt: string;
  body: string;
};

export const chatArchiveKey = (threadId: string) => `chat/${threadId}.jsonl.gz`;

function encode(lines: ArchivedLine[]): Uint8Array {
  const text = lines.map((line) => JSON.stringify(line)).join("\n");
  return gzipSync(Buffer.from(text, "utf8"));
}

function decode(body: Uint8Array): ArchivedLine[] {
  const text = gunzipSync(body).toString("utf8");
  if (text.length === 0) return [];
  return text.split("\n").map((line) => JSON.parse(line) as ArchivedLine);
}

export type ArchiveOutcome =
  "not_due" | "not_found" | "empty" | "archived" | "already";

/** What closes a report about a chat message that's archived first. */
export const ARCHIVED_BEFORE_REVIEW = "archived before review";

/**
 * Closes the open queue items about the thread's chat messages, before they
 * go: dismissed, with nobody as the resolver, keeping the snapshot. A
 * message that's archived can't be acted on, so its item would stay open
 * for good. Logged-out reporters' addresses go too, as at any resolution
 * (DM 5.10).
 */
async function closeArchivedItems(db: Db, now: Date, threadId: string) {
  const messages = db
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(eq(chatMessages.threadId, threadId));
  const closed = await db
    .update(modQueueItems)
    .set({
      status: "dismissed",
      resolvedBy: null,
      resolvedAt: now,
      resolution: ARCHIVED_BEFORE_REVIEW,
      version: sql`${modQueueItems.version} + 1`,
    })
    .where(
      and(
        eq(modQueueItems.status, "open"),
        eq(modQueueItems.targetType, "chat_message"),
        inArray(modQueueItems.targetId, messages),
      ),
    )
    .returning({ id: modQueueItems.id });
  if (closed.length > 0) {
    await db
      .update(reports)
      .set({ reporterContact: null })
      .where(
        inArray(
          reports.queueItemId,
          closed.map((c) => c.id),
        ),
      );
  }
}

/**
 * Archives one session thread's chat, once its session ended 30 or more
 * days ago. The order makes a crash at any point safe to run again: upload,
 * read back and count, then the row and the delete in one transaction.
 */
export async function archiveThreadChat(
  db: Db,
  store: ChatArchiveStore,
  now: Date,
  threadId: string,
): Promise<ArchiveOutcome> {
  const [thread] = await db
    .select({ end: sessions.scheduledEnd })
    .from(threads)
    .innerJoin(sessions, eq(sessions.id, threads.sessionId))
    .where(and(eq(threads.id, threadId), eq(threads.kind, "session")));
  if (!thread) return "not_found";
  if (thread.end.getTime() + ARCHIVE_AFTER_DAYS * DAY_MS > now.getTime()) {
    return "not_due";
  }

  const [done] = await db
    .select({ threadId: chatArchives.threadId })
    .from(chatArchives)
    .where(eq(chatArchives.threadId, threadId));
  if (done) {
    // A run that recorded the file and died before the delete committed
    // can't happen (they share a transaction), but rows sent since can't
    // either: chat closed a month ago. Clear anything left all the same.
    await closeArchivedItems(db, now, threadId);
    await db.delete(chatMessages).where(eq(chatMessages.threadId, threadId));
    return "already";
  }

  const rows = await db
    .select({
      id: chatMessages.id,
      authorUserId: chatMessages.authorUserId,
      createdAt: chatMessages.createdAt,
      body: chatMessages.body,
    })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.threadId, threadId),
        eq(chatMessages.status, "visible"),
      ),
    )
    .orderBy(asc(chatMessages.id));
  if (rows.length === 0) {
    // Nothing to keep: removed messages only, or no chat at all.
    await closeArchivedItems(db, now, threadId);
    await db.delete(chatMessages).where(eq(chatMessages.threadId, threadId));
    return "empty";
  }

  const lines: ArchivedLine[] = rows.map((r) => ({
    id: r.id,
    authorUserId: r.authorUserId,
    createdAt: r.createdAt.toISOString(),
    body: r.body,
  }));
  const key = chatArchiveKey(threadId);
  const body = encode(lines);
  await store.put(key, body);

  // Read it back: the rows go only once the file holds every one of them.
  const stored = await store.get(key);
  const count = stored ? decode(stored).length : -1;
  if (count !== lines.length) {
    throw new Error(
      `archiveThreadChat: the file holds ${count} of ${lines.length} messages`,
    );
  }

  await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    await t
      .insert(chatArchives)
      .values({
        threadId,
        objectKey: key,
        messageCount: lines.length,
        firstMessageAt: rows[0]!.createdAt,
        lastMessageAt: rows[rows.length - 1]!.createdAt,
        bytes: body.byteLength,
        archivedAt: now,
      })
      .onConflictDoNothing();
    await closeArchivedItems(t, now, threadId);
    await t.delete(chatMessages).where(eq(chatMessages.threadId, threadId));
  });
  return "archived";
}

/**
 * Every session thread whose session ended 30 or more days ago and still has
 * chat rows: the daily sweep. Returns how many were archived.
 */
export async function archiveDueChats(
  db: Db,
  store: ChatArchiveStore,
  now: Date,
): Promise<number> {
  const due = await db
    .selectDistinct({ id: threads.id })
    .from(threads)
    .innerJoin(sessions, eq(sessions.id, threads.sessionId))
    .innerJoin(chatMessages, eq(chatMessages.threadId, threads.id))
    .where(
      and(
        eq(threads.kind, "session"),
        isNotNull(threads.sessionId),
        lte(
          sessions.scheduledEnd,
          new Date(now.getTime() - ARCHIVE_AFTER_DAYS * DAY_MS),
        ),
      ),
    )
    .orderBy(asc(threads.id));
  let archived = 0;
  for (const { id } of due) {
    if ((await archiveThreadChat(db, store, now, id)) === "archived") {
      archived++;
    }
  }
  return archived;
}

/** A thread's archived lines, oldest first, or null when it has no file. */
export async function archivedChat(
  store: ChatArchiveStore,
  threadId: string,
): Promise<ArchivedLine[] | null> {
  const body = await store.get(chatArchiveKey(threadId));
  return body ? decode(body) : null;
}

/** What the thread page shows under the discussion. */
export type ChatReplay = {
  messages: ChatMessageView[];
  /** All of them, when `messages` stops at the limit. */
  total: number;
  /** The archive exists but the bucket can't be read from here. */
  unavailable: boolean;
};

/** At most this many messages replay on the page. */
export const REPLAY_LIMIT = 500;

/**
 * A session thread's chat, after the chat: the live rows until they are
 * archived, then the file. Null when there was no chat. `store` is null on a
 * host that has no access to the bucket.
 */
export async function chatReplay(
  db: Db,
  store: ChatArchiveStore | null,
  threadId: string,
  limit = REPLAY_LIMIT,
): Promise<ChatReplay | null> {
  const [archive] = await db
    .select({ count: chatArchives.messageCount })
    .from(chatArchives)
    .where(eq(chatArchives.threadId, threadId));

  let lines: {
    id: string;
    authorUserId: string;
    createdAt: Date;
    body: string;
  }[];
  let total: number;
  if (archive) {
    if (!store)
      return { messages: [], total: archive.count, unavailable: true };
    // A failed read (the network, wrong keys) shows the note, not an error
    // page: the rest of the thread doesn't need the bucket.
    const file = await archivedChat(store, threadId).catch((error) => {
      console.error(
        "chat replay: the archive can't be read:",
        error instanceof Error ? error.name : "unknown error",
      );
      return null;
    });
    if (!file) return { messages: [], total: archive.count, unavailable: true };
    total = file.length;
    lines = file.slice(0, limit).map((l) => ({
      ...l,
      createdAt: new Date(l.createdAt),
    }));
  } else {
    const [{ count }] = (await db
      .select({ count: sql<number>`count(*)::int` })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.threadId, threadId),
          eq(chatMessages.status, "visible"),
        ),
      )) as [{ count: number }];
    total = count;
    lines = await db
      .select({
        id: chatMessages.id,
        authorUserId: chatMessages.authorUserId,
        createdAt: chatMessages.createdAt,
        body: chatMessages.body,
      })
      .from(chatMessages)
      .where(
        and(
          eq(chatMessages.threadId, threadId),
          eq(chatMessages.status, "visible"),
        ),
      )
      .orderBy(asc(chatMessages.id))
      .limit(limit);
  }
  if (total === 0) return null;

  // Names now, not then: a deleted account shows as "deleted user" (DM 5.1).
  const ids = [...new Set(lines.map((l) => l.authorUserId))];
  const names = new Map(
    ids.length === 0
      ? []
      : (
          await db
            .select({
              id: users.id,
              username: users.username,
              displayUsername: users.displayUsername,
              status: profiles.status,
            })
            .from(users)
            .leftJoin(profiles, eq(profiles.userId, users.id))
            .where(inArray(users.id, ids))
        ).map((u) => [
          u.id,
          u.status === "deleted"
            ? DELETED_USER
            : (u.displayUsername ?? u.username ?? DELETED_USER),
        ]),
  );
  return {
    messages: lines.map((l) => ({
      id: l.id,
      author: names.get(l.authorUserId) ?? DELETED_USER,
      body: l.body,
      createdAt: l.createdAt.toISOString(),
    })),
    total,
    unavailable: false,
  };
}

/** The person's own archived lines, for the data export (DM 6.7). */
export async function archivedChatOf(
  db: Db,
  store: ChatArchiveStore,
  userId: string,
): Promise<
  { id: string; threadId: string; body: string; createdAt: string }[]
> {
  const archives = await db
    .select({ threadId: chatArchives.threadId })
    .from(chatArchives)
    .orderBy(asc(chatArchives.threadId));
  const out: {
    id: string;
    threadId: string;
    body: string;
    createdAt: string;
  }[] = [];
  for (const { threadId } of archives) {
    const lines = (await archivedChat(store, threadId)) ?? [];
    for (const line of lines) {
      if (line.authorUserId !== userId) continue;
      out.push({
        id: line.id,
        threadId,
        body: line.body,
        createdAt: line.createdAt,
      });
    }
  }
  return out;
}
