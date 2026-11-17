import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import { categoryId, seedViewer } from "../../tests/helpers/community";
import {
  postMentions,
  postRevisions,
  posts,
  postVotes,
  profiles,
  threads,
} from "@/db/schema";
import type { Viewer } from "@/identity/viewer";
import { newId } from "@/lib/ids";
import { deleteOwnPost, editPost, reply } from "./posts";
import { createThread } from "./threads";
import { vote } from "./votes";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

const NOW = new Date("2026-03-07T12:00:00Z");
/** A minute apart, so rate limits never get in the way. */
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 600_000);

describe("threads, posts and votes", () => {
  let t: TestDb;
  let ada: Viewer;
  let bea: Viewer;

  beforeEach(async () => {
    t = await createTestDb();
    ada = await seedViewer(t.db, { trustLevel: 1, username: "late_braker" });
    bea = await seedViewer(t.db, { trustLevel: 1, username: "bea" });
  });

  afterEach(async () => {
    await t.close();
  });

  async function start(viewer = ada, minute = 0) {
    const result = await createThread(t.db, at(minute), viewer, {
      categoryId: await categoryId(t.db, "general"),
      title: "Tyre strategy",
      body: "Two stops or one?",
      containsSpoilers: false,
    });
    if (!result.ok) throw new Error(result.error);
    return result;
  }

  const postRow = async (id: string) =>
    (await t.db.select().from(posts).where(eq(posts.id, id)))[0]!;
  const threadRow = async (id: string) =>
    (await t.db.select().from(threads).where(eq(threads.id, id)))[0]!;

  it("a new thread has its opening post, and TL0 can't start one", async () => {
    const { threadId, postId, status } = await start();
    expect(status).toBe("visible");
    expect(await postRow(postId)).toMatchObject({
      threadId,
      isOpening: true,
      depth: 0,
      parentPostId: null,
      body: "Two stops or one?",
      status: "visible",
    });
    expect(await threadRow(threadId)).toMatchObject({
      title: "Tyre strategy",
      kind: "user",
      authorUserId: ada.userId,
      replyCount: 0,
      lastActivityAt: at(0),
    });

    const tl0 = await seedViewer(t.db, { trustLevel: 0 });
    expect(
      await createThread(t.db, NOW, tl0, {
        categoryId: await categoryId(t.db, "general"),
        title: "Hi",
        body: "Hello",
        containsSpoilers: false,
      }),
    ).toEqual({ ok: false, error: "trust_too_low" });
  });

  it("a reply three deep has depth 3 and its path ends in its own id", async () => {
    const { threadId } = await start();
    const one = await reply(t.db, at(1), bea, { threadId, body: "One stop" });
    if (!one.ok) throw new Error(one.error);
    const two = await reply(t.db, at(2), ada, {
      threadId,
      parentPostId: one.postId,
      body: "On mediums?",
    });
    if (!two.ok) throw new Error(two.error);
    const three = await reply(t.db, at(3), bea, {
      threadId,
      parentPostId: two.postId,
      body: "Hards",
    });
    if (!three.ok) throw new Error(three.error);

    const row = await postRow(three.postId);
    expect(row.depth).toBe(3);
    expect(row.parentPostId).toBe(two.postId);
    expect(row.path.split(".")).toEqual(
      [one.postId, two.postId, three.postId].map((id) =>
        id.replaceAll("-", "_"),
      ),
    );
    expect(await threadRow(threadId)).toMatchObject({
      replyCount: 3,
      lastActivityAt: at(3),
    });

    // A parent from another thread isn't a parent here.
    const other = await start(bea, 4);
    expect(
      await reply(t.db, at(5), ada, {
        threadId,
        parentPostId: other.postId,
        body: "Wrong thread",
      }),
    ).toEqual({ ok: false, error: "not_found" });
  });

  it("a reply takes the thread's spoiler scope", async () => {
    const { threadId } = await start();
    await t.db
      .update(threads)
      .set({ containsSpoilers: true })
      .where(eq(threads.id, threadId));
    const r = await reply(t.db, at(1), bea, { threadId, body: "Wow" });
    if (!r.ok) throw new Error(r.error);
    expect(await postRow(r.postId)).toMatchObject({ containsSpoilers: true });
  });

  it("an edit keeps the old text in post_revisions", async () => {
    const { threadId } = await start();
    const r = await reply(t.db, at(1), bea, { threadId, body: "First take" });
    if (!r.ok) throw new Error(r.error);
    expect(
      await editPost(t.db, at(2), bea, {
        postId: r.postId,
        body: "Better take",
      }),
    ).toEqual({ ok: true, status: "visible" });
    expect(await postRow(r.postId)).toMatchObject({
      body: "Better take",
      editCount: 1,
      editedAt: at(2),
    });
    expect(
      await t.db
        .select({ body: postRevisions.body, editedBy: postRevisions.editedBy })
        .from(postRevisions)
        .where(eq(postRevisions.postId, r.postId)),
    ).toEqual([{ body: "First take", editedBy: bea.userId }]);

    // Only the author edits, and the gate reads the new text.
    expect(
      await editPost(t.db, at(3), ada, { postId: r.postId, body: "Mine now" }),
    ).toEqual({ ok: false, error: "forbidden" });
    const tl0 = await seedViewer(t.db, { trustLevel: 0 });
    const mine = await reply(t.db, at(4), tl0, { threadId, body: "No links" });
    if (!mine.ok) throw new Error(mine.error);
    expect(
      await editPost(t.db, at(5), tl0, {
        postId: mine.postId,
        body: "See https://spam.example",
      }),
    ).toEqual({ ok: false, error: "links_not_allowed" });
    // An edit isn't a new post: no rate limit, and not a duplicate of itself.
    expect(
      await editPost(t.db, at(5), tl0, {
        postId: mine.postId,
        body: "No links",
      }),
    ).toEqual({ ok: true, status: "visible" });
  });

  it('deleting a post with replies leaves "[deleted]" and the replies', async () => {
    const { threadId } = await start();
    const parent = await reply(t.db, at(1), bea, {
      threadId,
      body: "Hot take",
    });
    if (!parent.ok) throw new Error(parent.error);
    const child = await reply(t.db, at(2), ada, {
      threadId,
      parentPostId: parent.postId,
      body: "Disagree",
    });
    if (!child.ok) throw new Error(child.error);

    expect(
      await deleteOwnPost(t.db, at(3), ada, { postId: parent.postId }),
    ).toEqual({ ok: false, error: "forbidden" });
    expect(
      await deleteOwnPost(t.db, at(3), bea, { postId: parent.postId }),
    ).toEqual({ ok: true });
    expect(await postRow(parent.postId)).toMatchObject({
      body: "",
      status: "deleted_by_author",
    });
    expect(await postRow(child.postId)).toMatchObject({
      body: "Disagree",
      status: "visible",
      parentPostId: parent.postId,
    });
    // The text survives for moderators only.
    expect(
      await t.db
        .select({ body: postRevisions.body })
        .from(postRevisions)
        .where(eq(postRevisions.postId, parent.postId)),
    ).toEqual([{ body: "Hot take" }]);
    expect((await threadRow(threadId)).replyCount).toBe(1);
    // A deleted post can't be edited back.
    expect(
      await editPost(t.db, at(4), bea, { postId: parent.postId, body: "Back" }),
    ).toEqual({ ok: false, error: "not_found" });
  });

  it("changing a vote from up to down moves score by -2 and thread score with it", async () => {
    const { threadId, postId } = await start();
    expect(await vote(t.db, at(1), bea, { postId, value: 1 })).toEqual({
      ok: true,
      score: 1,
    });
    expect(await postRow(postId)).toMatchObject({
      score: 1,
      upvotes: 1,
      downvotes: 0,
    });
    expect((await threadRow(threadId)).score).toBe(1);

    expect(await vote(t.db, at(2), bea, { postId, value: -1 })).toEqual({
      ok: true,
      score: -1,
    });
    expect(await postRow(postId)).toMatchObject({
      score: -1,
      upvotes: 0,
      downvotes: 1,
    });
    expect((await threadRow(threadId)).score).toBe(-1);

    // The same vote again changes nothing; 0 removes it.
    await vote(t.db, at(3), bea, { postId, value: -1 });
    expect((await postRow(postId)).score).toBe(-1);
    expect(await vote(t.db, at(4), bea, { postId, value: 0 })).toEqual({
      ok: true,
      score: 0,
    });
    expect(await t.db.select().from(postVotes)).toEqual([]);
    expect((await threadRow(threadId)).score).toBe(0);

    // A reply's vote leaves the thread's score alone.
    const r = await reply(t.db, at(5), bea, { threadId, body: "Agreed" });
    if (!r.ok) throw new Error(r.error);
    await vote(t.db, at(6), ada, { postId: r.postId, value: 1 });
    expect((await threadRow(threadId)).score).toBe(0);
    // Nobody votes on their own post.
    expect(await vote(t.db, at(7), ada, { postId, value: 1 })).toEqual({
      ok: false,
      error: "forbidden",
    });
  });

  it("TL0 downvote is refused", async () => {
    const { postId } = await start();
    const tl0 = await seedViewer(t.db, { trustLevel: 0 });
    expect(await vote(t.db, at(1), tl0, { postId, value: -1 })).toEqual({
      ok: false,
      error: "trust_too_low",
    });
    expect(await vote(t.db, at(1), tl0, { postId, value: 1 })).toEqual({
      ok: true,
      score: 1,
    });
  });

  it("a mention of @late_braker writes one post_mentions row, and a mention of an unknown name writes none", async () => {
    const { threadId } = await start();
    const r = await reply(t.db, at(1), bea, {
      threadId,
      body: "@late_braker @Late_Braker @nobody_here what do you think?",
    });
    if (!r.ok) throw new Error(r.error);
    expect(
      await t.db
        .select({ userId: postMentions.userId })
        .from(postMentions)
        .where(eq(postMentions.postId, r.postId)),
    ).toEqual([{ userId: ada.userId }]);

    // A deleted account isn't mentioned.
    await t.db
      .update(profiles)
      .set({ status: "deleted" })
      .where(eq(profiles.userId, ada.userId));
    const again = await reply(t.db, at(2), bea, {
      threadId,
      body: "@late_braker still there?",
    });
    if (!again.ok) throw new Error(again.error);
    expect(
      await t.db
        .select()
        .from(postMentions)
        .where(eq(postMentions.postId, again.postId)),
    ).toEqual([]);
  });

  it("a held reply is pending_review and doesn't count as a reply yet", async () => {
    const { threadId } = await start();
    const { filterRules } = await import("@/db/schema");
    const { SYSTEM_USER_ID } = await import("@/identity/system");
    await t.db.insert(filterRules).values({
      id: newId(),
      pattern: "crypto",
      matchType: "word",
      effect: "hold_for_review",
      scope: "all",
      createdBy: SYSTEM_USER_ID,
    });
    const r = await reply(t.db, at(1), bea, { threadId, body: "Buy crypto" });
    expect(r).toMatchObject({ ok: true, status: "pending_review" });
    expect((await threadRow(threadId)).replyCount).toBe(0);
    const rows = await t.db
      .select({ status: posts.status })
      .from(posts)
      .where(eq(posts.threadId, threadId))
      .orderBy(asc(posts.path));
    expect(rows.map((p) => p.status)).toEqual(["visible", "pending_review"]);
  });

  it("a locked thread takes no replies", async () => {
    const { threadId } = await start();
    await t.db
      .update(threads)
      .set({ status: "locked" })
      .where(eq(threads.id, threadId));
    expect(await reply(t.db, at(1), bea, { threadId, body: "Late" })).toEqual({
      ok: false,
      error: "thread_locked",
    });
  });
});
