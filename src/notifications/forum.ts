/**
 * The forum's notifications: a reply to someone's post or thread, and a
 * mention. They run inside the post's transaction, and only for a post
 * that's visible: a held post notifies no one until it's approved.
 */
import { eq } from "drizzle-orm";
import { threads } from "@/db/schema";
import type { Db } from "@/db/types";
import { notify } from "./write";

export type NotifiedThread = {
  id: string;
  title: string;
  spoilerSafeTitle: string | null;
  containsSpoilers: boolean;
  sessionId: string | null;
};

/** The title values: a spoiler thread with no session always reads safe. */
function titleData(thread: NotifiedThread) {
  const safe = thread.containsSpoilers ? thread.spoilerSafeTitle : null;
  return {
    title: safe && !thread.sessionId ? safe : thread.title,
    safeTitle: safe,
  };
}

/**
 * Notifies the people a new post mentions and the author it replies to. A
 * person both mentioned and replied to gets the mention only.
 */
export async function notifyPost(
  db: Db,
  now: Date,
  input: {
    actorUserId: string;
    thread: NotifiedThread;
    postId: string;
    mentioned: string[];
    /** The parent post's author, or the thread's; null for none. */
    repliedTo?: string | null;
  },
): Promise<void> {
  const refs = {
    threadId: input.thread.id,
    postId: input.postId,
    sessionId: input.thread.sessionId,
  };
  const data = titleData(input.thread);
  for (const userId of new Set(input.mentioned)) {
    await notify(db, now, {
      userId,
      kind: "mention",
      actorUserId: input.actorUserId,
      refs,
      data,
    });
  }
  const to = input.repliedTo;
  if (to && !input.mentioned.includes(to)) {
    await notify(db, now, {
      userId: to,
      kind: "reply",
      groupKey: `reply:${input.thread.id}`,
      actorUserId: input.actorUserId,
      refs,
      data,
    });
  }
}

/** The thread values a notification needs. */
export async function threadForNotify(
  db: Db,
  threadId: string,
): Promise<NotifiedThread | null> {
  const [row] = await db
    .select({
      id: threads.id,
      title: threads.title,
      spoilerSafeTitle: threads.spoilerSafeTitle,
      containsSpoilers: threads.containsSpoilers,
      sessionId: threads.sessionId,
    })
    .from(threads)
    .where(eq(threads.id, threadId));
  return row ?? null;
}
