/**
 * Starting a thread (DM 5.3): the thread and its opening post, in one
 * transaction, after `canPost` and the gate.
 */
import { eq } from "drizzle-orm";
import { posts, sessions, threads, type PostStatus } from "@/db/schema";
import type { Db } from "@/db/types";
import { canPost, type Viewer } from "@/identity/viewer";
import { newId } from "@/lib/ids";
import { refuse, type CommunityRefusal } from "./errors";
import { checkPost } from "./gate";
import { pathLabel, writeMentions } from "./mentions";
import { notifyPost } from "@/notifications/forum";
import { queueFilterHits } from "./moderation";
import { hotRank } from "./upkeep";

/** What anyone who hasn't revealed the session sees for a spoiler thread. */
export const SPOILER_THREAD_TITLE = "Spoiler thread";

export type CreateThreadInput = {
  categoryId: string;
  title: string;
  body: string;
  /** Ties the thread to a session, which makes it spoiler-scoped. */
  sessionId?: string | null;
  /**
   * The author's answer to "Contains spoilers". Left out, the title check
   * decides (HLD §7.3); a plain no from the author wins over it.
   */
  containsSpoilers?: boolean;
};

export type CreateThreadResult =
  | { ok: true; threadId: string; postId: string; status: PostStatus }
  | CommunityRefusal;

export async function createThread(
  db: Db,
  now: Date,
  viewer: Viewer | null,
  input: CreateThreadInput,
): Promise<CreateThreadResult> {
  const v = canPost(viewer);
  const title = input.title.trim();
  const body = input.body.trim();
  const gate = await checkPost(db, now, v, {
    kind: "thread",
    categoryId: input.categoryId,
    title,
    body,
  });
  if (!gate.ok) return gate;

  let eventId: string | null = null;
  if (input.sessionId) {
    const [session] = await db
      .select({ eventId: sessions.eventId })
      .from(sessions)
      .where(eq(sessions.id, input.sessionId));
    if (!session) return refuse("not_found");
    eventId = session.eventId;
  }

  const spoilers = input.containsSpoilers ?? gate.spoilerTitle;
  const status: PostStatus = gate.hold ? "pending_review" : "visible";
  const threadId = newId();
  const postId = newId();
  await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    await t.insert(threads).values({
      id: threadId,
      categoryId: input.categoryId,
      kind: "user",
      title,
      spoilerSafeTitle: spoilers ? SPOILER_THREAD_TITLE : null,
      containsSpoilers: spoilers,
      authorUserId: v.userId,
      sessionId: input.sessionId ?? null,
      eventId,
      hotRank: hotRank(0, now),
      lastActivityAt: now,
      createdAt: now,
    });
    await t.insert(posts).values({
      id: postId,
      threadId,
      path: pathLabel(postId),
      depth: 0,
      isOpening: true,
      authorUserId: v.userId,
      body,
      sessionId: input.sessionId ?? null,
      containsSpoilers: spoilers,
      status,
      createdAt: now,
    });
    const mentioned = await writeMentions(t, postId, v.userId, body);
    if (status === "visible") {
      await notifyPost(t, now, {
        actorUserId: v.userId,
        thread: {
          id: threadId,
          title,
          spoilerSafeTitle: spoilers ? SPOILER_THREAD_TITLE : null,
          containsSpoilers: spoilers,
          sessionId: input.sessionId ?? null,
        },
        postId,
        mentioned,
      });
    }
    await queueFilterHits(
      t,
      now,
      {
        type: "thread",
        id: threadId,
        authorUserId: v.userId,
        threadId,
        title,
        body,
      },
      gate.flags,
    );
  });
  return { ok: true, threadId, postId, status };
}
