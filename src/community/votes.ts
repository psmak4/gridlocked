/**
 * Votes (DM 5.6): one per user per post, and the post's counters (and the
 * thread's score, for its opening post) change in the same transaction.
 * Downvotes need TL1 (HLD §7.4). Nobody votes on their own post.
 */
import { and, eq, sql } from "drizzle-orm";
import { posts, postVotes, threads } from "@/db/schema";
import type { Db } from "@/db/types";
import { requireWritable, type Viewer } from "@/identity/viewer";
import { refuse, type CommunityRefusal } from "./errors";
import { hotRankSql } from "./upkeep";

export type VoteValue = 1 | -1 | 0;

const STAFF = new Set(["moderator", "admin"]);

export async function vote(
  db: Db,
  now: Date,
  viewer: Viewer | null,
  input: { postId: string; value: VoteValue },
): Promise<{ ok: true; score: number } | CommunityRefusal> {
  const v = requireWritable(viewer);
  const level = STAFF.has(v.role) ? 3 : v.profile.trustLevel;
  if (input.value === -1 && level < 1) return refuse("trust_too_low");

  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    // The post row is the lock: two votes on one post take turns.
    const [post] = await t
      .select({
        threadId: posts.threadId,
        authorUserId: posts.authorUserId,
        status: posts.status,
        isOpening: posts.isOpening,
        score: posts.score,
      })
      .from(posts)
      .where(eq(posts.id, input.postId))
      .for("no key update");
    if (!post || post.status !== "visible") return refuse("not_found");
    if (post.authorUserId === v.userId) return refuse("forbidden");

    const [existing] = await t
      .select({ value: postVotes.value })
      .from(postVotes)
      .where(
        and(eq(postVotes.postId, input.postId), eq(postVotes.userId, v.userId)),
      );
    const before = existing?.value ?? 0;
    const after = input.value;
    if (before === after) return { ok: true as const, score: post.score };

    if (after === 0) {
      await t
        .delete(postVotes)
        .where(
          and(
            eq(postVotes.postId, input.postId),
            eq(postVotes.userId, v.userId),
          ),
        );
    } else {
      await t
        .insert(postVotes)
        .values({
          postId: input.postId,
          userId: v.userId,
          value: after,
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: [postVotes.postId, postVotes.userId],
          set: { value: after, createdAt: now },
        });
    }

    const delta = after - before;
    const up = (after === 1 ? 1 : 0) - (before === 1 ? 1 : 0);
    const down = (after === -1 ? 1 : 0) - (before === -1 ? 1 : 0);
    const [updated] = await t
      .update(posts)
      .set({
        score: sql`${posts.score} + ${delta}`,
        upvotes: sql`${posts.upvotes} + ${up}`,
        downvotes: sql`${posts.downvotes} + ${down}`,
      })
      .where(eq(posts.id, input.postId))
      .returning({ score: posts.score });
    // Votes on a thread are votes on its opening post (DM 5.3).
    if (post.isOpening) {
      await t
        .update(threads)
        .set({
          score: sql`${threads.score} + ${delta}`,
          hotRank: hotRankSql(
            sql`${threads.score} + ${delta}`,
            threads.createdAt,
          ),
        })
        .where(eq(threads.id, post.threadId));
    }
    return { ok: true as const, score: updated!.score };
  });
}
