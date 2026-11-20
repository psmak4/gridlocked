import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import {
  categoryId,
  seedThread,
  seedViewer,
} from "../../tests/helpers/community";
import {
  chatMessages,
  filterRules,
  modQueueItems,
  posts,
  reports,
  threads,
} from "@/db/schema";
import { SYSTEM_USER_ID } from "@/identity/system";
import type { Viewer } from "@/identity/viewer";
import { newId } from "@/lib/ids";
import { report, type CaptchaVerifier } from "./moderation";
import { editPost, reply } from "./posts";
import { createThread } from "./threads";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

const NOW = new Date("2026-03-07T12:00:00Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 600_000);
const passes: CaptchaVerifier = async (token) => token === "good-token";

describe("reports, the queue and auto-hide (DM 5.8, 5.9)", () => {
  let t: TestDb;
  let author: Viewer;
  let threadId: string;
  let postId: string;

  beforeEach(async () => {
    t = await createTestDb();
    author = await seedViewer(t.db, { trustLevel: 1, username: "author" });
    const started = await createThread(t.db, at(0), author, {
      categoryId: await categoryId(t.db, "general"),
      title: "Tyre strategy",
      body: "Two stops or one?",
      containsSpoilers: false,
    });
    if (!started.ok) throw new Error(started.error);
    threadId = started.threadId;
    const replied = await reply(t.db, at(1), author, {
      threadId,
      body: "One stop, surely.",
    });
    if (!replied.ok) throw new Error(replied.error);
    postId = replied.postId;
  });

  afterEach(async () => {
    await t.close();
  });

  const postRow = async (id: string) =>
    (await t.db.select().from(posts).where(eq(posts.id, id)))[0]!;
  const items = () => t.db.select().from(modQueueItems);
  const reportPost = (reporter: Viewer, minute = 2) =>
    report(
      t.db,
      at(minute),
      reporter,
      { targetType: "post", targetId: postId, reason: "abuse" },
      { verifyCaptcha: passes },
    );

  it("a second report by the same person changes nothing", async () => {
    const fan = await seedViewer(t.db, { trustLevel: 2, username: "fan" });
    const first = await reportPost(fan);
    expect(first).toMatchObject({ ok: true, hidden: false });
    const second = await reportPost(fan, 3);
    expect(second).toMatchObject({ ok: true, hidden: false });
    const [item] = await items();
    expect(item).toMatchObject({
      targetType: "post",
      targetId: postId,
      targetUserId: author.userId,
      source: "reports",
      reportCount: 1,
      weightSum: 2,
      status: "open",
    });
    expect(await t.db.select().from(reports)).toHaveLength(1);
  });

  it("TL3's report alone auto-hides at weight 5", async () => {
    const regular = await seedViewer(t.db, { trustLevel: 3, username: "reg" });
    const result = await reportPost(regular);
    expect(result).toMatchObject({ ok: true, hidden: true });
    expect((await postRow(postId)).status).toBe("hidden_by_flags");
    const [item] = await items();
    expect(item).toMatchObject({ weightSum: 5, source: "auto_hide" });
    // The hidden reply leaves the thread's count.
    const [thread] = await t.db
      .select({ replyCount: threads.replyCount })
      .from(threads)
      .where(eq(threads.id, threadId));
    expect(thread!.replyCount).toBe(0);
  });

  it("a moderator's report counts as TL3", async () => {
    const mod = await seedViewer(t.db, {
      trustLevel: 0,
      username: "mod",
      role: "moderator",
    });
    expect(await reportPost(mod)).toMatchObject({ ok: true, hidden: true });
  });

  it("five TL0 reports auto-hide", async () => {
    for (let i = 0; i < 4; i++) {
      const fan = await seedViewer(t.db, { trustLevel: 0, username: `n${i}` });
      expect(await reportPost(fan)).toMatchObject({ ok: true, hidden: false });
    }
    expect((await postRow(postId)).status).toBe("visible");
    const fifth = await seedViewer(t.db, { trustLevel: 0, username: "n4" });
    expect(await reportPost(fifth)).toMatchObject({ ok: true, hidden: true });
    expect((await postRow(postId)).status).toBe("hidden_by_flags");
    const [item] = await items();
    expect(item).toMatchObject({ reportCount: 5, weightSum: 5 });
  });

  it("logged-out reports queue the post but never hide it", async () => {
    // One person can file any number of these (no account to tie them to),
    // so they reach a moderator without counting toward auto-hide.
    for (let i = 0; i < 6; i++) {
      const result = await report(
        t.db,
        at(2),
        { contact: "same@example.test", captchaToken: "good-token" },
        { targetType: "post", targetId: postId, reason: "abuse" },
        { verifyCaptcha: passes },
      );
      expect(result).toMatchObject({ ok: true, hidden: false });
    }
    expect((await postRow(postId)).status).toBe("visible");
    const [item] = await items();
    expect(item).toMatchObject({ reportCount: 6, weightSum: 0 });
  });

  it("the system account's posts are queued but never auto-hidden", async () => {
    const replied = await reply(
      t.db,
      at(1),
      { ...author, userId: SYSTEM_USER_ID },
      { threadId, body: "Results are in." },
    );
    if (!replied.ok) throw new Error(replied.error);
    const regular = await seedViewer(t.db, { trustLevel: 3, username: "reg" });
    const result = await report(
      t.db,
      at(2),
      regular,
      { targetType: "post", targetId: replied.postId, reason: "spam" },
      { verifyCaptcha: passes },
    );
    expect(result).toMatchObject({ ok: true, hidden: false });
    expect((await postRow(replied.postId)).status).toBe("visible");
  });

  it("the snapshot keeps the text after the author edits it", async () => {
    const fan = await seedViewer(t.db, { trustLevel: 2, username: "fan" });
    await reportPost(fan);
    const edited = await editPost(t.db, at(3), author, {
      postId,
      body: "Nothing to see here.",
    });
    expect(edited.ok).toBe(true);
    const [item] = await items();
    expect(item!.contentSnapshot).toMatchObject({
      body: "One stop, surely.",
      edits: [{ body: "Nothing to see here.", at: at(3).toISOString() }],
    });
  });

  it("a logged-out report without a captcha is refused", async () => {
    const visitor = (captchaToken: string) =>
      report(
        t.db,
        at(2),
        { contact: "someone@example.test", captchaToken },
        { targetType: "post", targetId: postId, reason: "illegal" },
        { verifyCaptcha: passes },
      );
    expect(await visitor("")).toEqual({ ok: false, error: "captcha_failed" });
    expect(await visitor("bad-token")).toEqual({
      ok: false,
      error: "captcha_failed",
    });
    expect(await items()).toHaveLength(0);
    // With one it's taken, weighs nothing toward auto-hide and keeps the
    // address.
    expect(await visitor("good-token")).toMatchObject({ ok: true });
    const [row] = await t.db.select().from(reports);
    expect(row).toMatchObject({
      reporterUserId: null,
      reporterContact: "someone@example.test",
      weight: 0,
    });
  });

  it("a report on a thread hides it by hiding its opening post", async () => {
    const regular = await seedViewer(t.db, { trustLevel: 3, username: "reg" });
    const result = await report(
      t.db,
      at(2),
      regular,
      { targetType: "thread", targetId: threadId, reason: "spam" },
      { verifyCaptcha: passes },
    );
    expect(result).toMatchObject({ ok: true, hidden: true });
    const [opening] = await t.db
      .select({ status: posts.status })
      .from(posts)
      .where(eq(posts.threadId, threadId))
      .orderBy(posts.depth)
      .limit(1);
    expect(opening!.status).toBe("hidden_by_flags");
    const [item] = await items();
    expect(item!.contentSnapshot).toMatchObject({
      title: "Tyre strategy",
      body: "Two stops or one?",
    });
  });

  it("a chat message reported past the threshold is removed", async () => {
    const chatThread = await seedThread(t.db, { at: NOW, kind: "session" });
    const messageId = newId();
    await t.db.insert(chatMessages).values({
      id: messageId,
      threadId: chatThread,
      authorUserId: author.userId,
      body: "Lights out!",
      createdAt: NOW,
    });
    const regular = await seedViewer(t.db, { trustLevel: 3, username: "reg" });
    const result = await report(
      t.db,
      at(2),
      regular,
      { targetType: "chat_message", targetId: messageId, reason: "spoiler" },
      { verifyCaptcha: passes },
    );
    expect(result).toMatchObject({ ok: true, hidden: true });
    const [row] = await t.db
      .select({ status: chatMessages.status })
      .from(chatMessages)
      .where(eq(chatMessages.id, messageId));
    expect(row!.status).toBe("removed");
    const [item] = await items();
    expect(item!.contentSnapshot).toMatchObject({ body: "Lights out!" });
  });

  it("you can't report your own post, or one that isn't there", async () => {
    expect(await reportPost(author)).toEqual({ ok: false, error: "forbidden" });
    const fan = await seedViewer(t.db, { trustLevel: 2, username: "fan" });
    expect(
      await report(
        t.db,
        at(2),
        fan,
        { targetType: "post", targetId: newId(), reason: "spam" },
        { verifyCaptcha: passes },
      ),
    ).toEqual({ ok: false, error: "not_found" });
  });

  it("a filter hold or flag opens a queue item with the hits", async () => {
    for (const [pattern, effect] of [
      ["crypto", "hold_for_review"],
      ["idiot", "flag"],
    ] as const) {
      await t.db.insert(filterRules).values({
        id: newId(),
        pattern,
        matchType: "word",
        effect,
        scope: "all",
        createdBy: SYSTEM_USER_ID,
      });
    }
    const held = await reply(t.db, at(2), author, {
      threadId,
      body: "Buy crypto now",
    });
    if (!held.ok) throw new Error(held.error);
    expect(held.status).toBe("pending_review");
    const flagged = await reply(t.db, at(3), author, {
      threadId,
      body: "What an idiot move",
    });
    if (!flagged.ok) throw new Error(flagged.error);
    expect(flagged.status).toBe("visible");

    const rows = await items();
    expect(rows).toHaveLength(2);
    const byTarget = new Map(rows.map((r) => [r.targetId, r]));
    expect(byTarget.get(held.postId)).toMatchObject({
      source: "filter",
      reportCount: 0,
      contentSnapshot: { body: "Buy crypto now" },
      filterHits: [expect.objectContaining({ pattern: "crypto" })],
    });
    expect(byTarget.get(flagged.postId)).toMatchObject({
      source: "filter",
      filterHits: [expect.objectContaining({ effect: "flag" })],
    });
  });
});
