/**
 * Replies, edits and an author's own deletes (DM 5.4). Each write is one
 * transaction, and the thread's `reply_count` counts visible replies: a held
 * reply joins the count when a moderator lets it through.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { postRevisions, posts, threads, type PostStatus } from "@/db/schema";
import type { Db } from "@/db/types";
import { canPost, type Viewer } from "@/identity/viewer";
import { newId } from "@/lib/ids";
import { refuse, type CommunityRefusal } from "./errors";
import { checkPost } from "./gate";
import { pathLabel, writeMentions } from "./mentions";
import { noteEdit, queueFilterHits } from "./moderation";
import { notifyPost, threadForNotify } from "@/notifications/forum";

export type ReplyInput = {
  threadId: string;
  /** Null or absent for a top-level reply. */
  parentPostId?: string | null;
  body: string;
};

export type ReplyResult =
  { ok: true; postId: string; status: PostStatus } | CommunityRefusal;

/** Posts an author can still change: not removed and not deleted. */
const EDITABLE: PostStatus[] = ["visible", "pending_review", "hidden_by_flags"];

export async function reply(
  db: Db,
  now: Date,
  viewer: Viewer | null,
  input: ReplyInput,
): Promise<ReplyResult> {
  const v = canPost(viewer);
  const body = input.body.trim();
  const gate = await checkPost(db, now, v, {
    kind: "reply",
    threadId: input.threadId,
    body,
  });
  if (!gate.ok) return gate;

  let parent: {
    path: string;
    depth: number;
    authorUserId: string | null;
  } | null = null;
  if (input.parentPostId) {
    const [row] = await db
      .select({
        path: posts.path,
        depth: posts.depth,
        authorUserId: posts.authorUserId,
      })
      .from(posts)
      .where(
        and(
          eq(posts.id, input.parentPostId),
          eq(posts.threadId, input.threadId),
          eq(posts.isOpening, false),
        ),
      );
    if (!row) return refuse("not_found");
    parent = row;
  }

  const postId = newId();
  const status: PostStatus = gate.hold ? "pending_review" : "visible";
  const visible = status === "visible";
  return db.transaction(async (tx): Promise<ReplyResult> => {
    const t = tx as unknown as Db;
    // The thread must still be open: a lock that lands after the gate wins.
    const [thread] = await t
      .update(threads)
      .set({
        lastActivityAt: now,
        replyCount: visible
          ? sql`${threads.replyCount} + 1`
          : sql`${threads.replyCount}`,
      })
      .where(and(eq(threads.id, input.threadId), eq(threads.status, "open")))
      .returning({
        id: threads.id,
        title: threads.title,
        spoilerSafeTitle: threads.spoilerSafeTitle,
        authorUserId: threads.authorUserId,
        sessionId: threads.sessionId,
        containsSpoilers: threads.containsSpoilers,
      });
    if (!thread) return refuse("thread_locked");
    await t.insert(posts).values({
      id: postId,
      threadId: input.threadId,
      parentPostId: input.parentPostId ?? null,
      path: parent ? `${parent.path}.${pathLabel(postId)}` : pathLabel(postId),
      // The opening post is depth 0, so a top-level reply is 1.
      depth: parent ? parent.depth + 1 : 1,
      isOpening: false,
      authorUserId: v.userId,
      body,
      sessionId: thread.sessionId,
      containsSpoilers: thread.containsSpoilers,
      status,
      createdAt: now,
    });
    const mentioned = await writeMentions(t, postId, v.userId, body);
    if (visible) {
      await notifyPost(t, now, {
        actorUserId: v.userId,
        thread,
        postId,
        mentioned,
        repliedTo: parent ? parent.authorUserId : thread.authorUserId,
      });
    }
    await queueFilterHits(
      t,
      now,
      {
        type: "post",
        id: postId,
        authorUserId: v.userId,
        threadId: input.threadId,
        body,
      },
      gate.flags,
    );
    return { ok: true, postId, status };
  });
}

/** The author's own post, if they can still change it. */
async function ownPost(db: Db, viewer: Viewer, postId: string) {
  const [row] = await db
    .select({
      threadId: posts.threadId,
      authorUserId: posts.authorUserId,
      body: posts.body,
      status: posts.status,
      isOpening: posts.isOpening,
    })
    .from(posts)
    .where(eq(posts.id, postId));
  if (!row || !EDITABLE.includes(row.status)) return refuse("not_found");
  if (row.authorUserId !== viewer.userId) return refuse("forbidden");
  return { ok: true as const, ...row };
}

/** A new text for the author's post. The old one goes to `post_revisions`. */
export async function editPost(
  db: Db,
  now: Date,
  viewer: Viewer | null,
  input: { postId: string; body: string },
): Promise<{ ok: true; status: PostStatus } | CommunityRefusal> {
  const v = canPost(viewer);
  const post = await ownPost(db, v, input.postId);
  if (!post.ok) return post;
  const body = input.body.trim();
  if (body === post.body) return { ok: true, status: post.status };
  const gate = await checkPost(db, now, v, {
    kind: "edit",
    threadId: post.threadId,
    body,
  });
  if (!gate.ok) return gate;

  // A filter hold sends a visible post back to review; otherwise it keeps
  // its status (a post already held or hidden stays so).
  const status: PostStatus =
    gate.hold && post.status === "visible" ? "pending_review" : post.status;
  await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    await t.insert(postRevisions).values({
      id: newId(),
      postId: input.postId,
      body: post.body,
      editedAt: now,
      editedBy: v.userId,
    });
    const [updated] = await t
      .update(posts)
      .set({
        body,
        status,
        editCount: sql`${posts.editCount} + 1`,
        editedAt: now,
      })
      .where(and(eq(posts.id, input.postId), inArray(posts.status, EDITABLE)))
      .returning({ id: posts.id });
    if (!updated) throw new Error("post changed during edit");
    if (status !== post.status && !post.isOpening) {
      await t
        .update(threads)
        .set({ replyCount: sql`greatest(${threads.replyCount} - 1, 0)` })
        .where(eq(threads.id, post.threadId));
    }
    const mentioned = await writeMentions(t, input.postId, v.userId, body);
    if (status === "visible" && mentioned.length > 0) {
      const thread = await threadForNotify(t, post.threadId);
      if (thread) {
        await notifyPost(t, now, {
          actorUserId: v.userId,
          thread,
          postId: input.postId,
          mentioned,
        });
      }
    }
    // The queue keeps what was first reported; the new text joins it, and a
    // hit on the new text is queued against the post (or its thread).
    await noteEdit(t, now, {
      postId: input.postId,
      threadId: post.threadId,
      isOpening: post.isOpening,
      body,
    });
    await queueFilterHits(
      t,
      now,
      {
        type: post.isOpening ? "thread" : "post",
        id: post.isOpening ? post.threadId : input.postId,
        authorUserId: v.userId,
        threadId: post.threadId,
        body,
      },
      gate.flags,
    );
  });
  return { ok: true, status };
}

/**
 * The author deletes their own post: the row stays as "[deleted]" with its
 * body cleared, so replies keep their place (DM 5.4). The text survives in
 * `post_revisions` for moderators.
 */
export async function deleteOwnPost(
  db: Db,
  now: Date,
  viewer: Viewer | null,
  input: { postId: string },
): Promise<{ ok: true } | CommunityRefusal> {
  const v = canPost(viewer);
  const post = await ownPost(db, v, input.postId);
  if (!post.ok) return post;
  await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    await t.insert(postRevisions).values({
      id: newId(),
      postId: input.postId,
      body: post.body,
      editedAt: now,
      editedBy: v.userId,
    });
    await t
      .update(posts)
      .set({ body: "", status: "deleted_by_author" })
      .where(eq(posts.id, input.postId));
    if (post.status === "visible" && !post.isOpening) {
      await t
        .update(threads)
        .set({ replyCount: sql`greatest(${threads.replyCount} - 1, 0)` })
        .where(eq(threads.id, post.threadId));
    }
  });
  return { ok: true };
}
