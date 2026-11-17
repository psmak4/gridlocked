import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import { categoryId, seedViewer } from "../../tests/helpers/community";
import {
  auditLog,
  modActions,
  modQueueItems,
  posts,
  reports,
  threads,
  userRestrictions,
} from "@/db/schema";
import type { Viewer } from "@/identity/viewer";
import {
  accountActions,
  moderate,
  staffActor,
  type ModerateInput,
} from "./moderate";
import { report, type CaptchaVerifier } from "./moderation";
import { reply } from "./posts";
import { createThread } from "./threads";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

const NOW = new Date("2026-03-07T12:00:00Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 600_000);
const HOUR = 60 * 60 * 1000;
const passes: CaptchaVerifier = async () => true;

describe("moderation actions (DM 5.9)", () => {
  let t: TestDb;
  let author: Viewer;
  let mod: Viewer;
  let admin: Viewer;
  let threadId: string;
  let postId: string;

  beforeEach(async () => {
    t = await createTestDb();
    author = await seedViewer(t.db, { trustLevel: 1, username: "author" });
    mod = await seedViewer(t.db, { username: "mod", role: "moderator" });
    admin = await seedViewer(t.db, { username: "boss", role: "admin" });
    const started = await createThread(t.db, at(0), author, {
      categoryId: await categoryId(t.db, "general"),
      title: "Russell wins in Monaco",
      body: "What a drive.",
      containsSpoilers: true,
    });
    if (!started.ok) throw new Error(started.error);
    threadId = started.threadId;
    const replied = await reply(t.db, at(1), author, {
      threadId,
      body: "Buy cheap tickets",
    });
    if (!replied.ok) throw new Error(replied.error);
    postId = replied.postId;
  });

  afterEach(async () => {
    await t.close();
  });

  const postRow = async () =>
    (await t.db.select().from(posts).where(eq(posts.id, postId)))[0]!;
  const threadRow = async () =>
    (await t.db.select().from(threads).where(eq(threads.id, threadId)))[0]!;
  const act = (viewer: Viewer, input: ModerateInput, minute = 2) =>
    moderate(t.db, at(minute), staffActor(viewer), input);

  async function hideByReport() {
    const regular = await seedViewer(t.db, { trustLevel: 3, username: "reg" });
    const filed = await report(
      t.db,
      at(2),
      regular,
      { targetType: "post", targetId: postId, reason: "spam" },
      { verifyCaptcha: passes },
    );
    if (!filed.ok) throw new Error(filed.error);
    const [item] = await t.db
      .select()
      .from(modQueueItems)
      .where(eq(modQueueItems.id, filed.queueItemId));
    return item!;
  }

  it("only staff can act", () => {
    expect(() => staffActor(author)).toThrow();
    expect(staffActor(mod)).toMatchObject({
      userId: mod.userId,
      kind: "moderator",
    });
  });

  it("two moderators resolving one item: the second gets a version conflict", async () => {
    const item = await hideByReport();
    const first = await act(mod, {
      action: "remove",
      targetType: "post",
      targetId: postId,
      reason: "Ticket spam",
      queueItemId: item.id,
      version: item.version,
    });
    expect(first).toMatchObject({ ok: true, changed: true });
    const second = await act(admin, {
      action: "restore",
      targetType: "post",
      targetId: postId,
      reason: "Looks fine",
      queueItemId: item.id,
      version: item.version,
    });
    expect(second).toEqual({ ok: false, error: "version_conflict" });
    // The first one stands: removed, and the item actioned by the moderator.
    expect((await postRow()).status).toBe("removed");
    const [resolved] = await t.db
      .select()
      .from(modQueueItems)
      .where(eq(modQueueItems.id, item.id));
    expect(resolved).toMatchObject({
      status: "actioned",
      resolvedBy: mod.userId,
      resolution: "remove",
    });
    expect(await t.db.select().from(modActions)).toHaveLength(1);
  });

  it("restore puts a hidden post back and logs it", async () => {
    const item = await hideByReport();
    expect((await postRow()).status).toBe("hidden_by_flags");
    expect((await threadRow()).replyCount).toBe(0);
    const result = await act(mod, {
      action: "restore",
      targetType: "post",
      targetId: postId,
      reason: "Not spam",
      queueItemId: item.id,
      version: item.version,
    });
    expect(result).toMatchObject({ ok: true, changed: true });
    expect((await postRow()).status).toBe("visible");
    expect((await threadRow()).replyCount).toBe(1);
    const [logged] = await t.db.select().from(modActions);
    expect(logged).toMatchObject({
      action: "restore",
      targetType: "post",
      targetId: postId,
      targetUserId: author.userId,
      moderatorUserId: mod.userId,
      reason: "Not spam",
      queueItemId: item.id,
    });
    // "Keep it" closes the reports.
    const [resolved] = await t.db
      .select({ status: modQueueItems.status })
      .from(modQueueItems)
      .where(eq(modQueueItems.id, item.id));
    expect(resolved!.status).toBe("dismissed");
  });

  it("resolving an item deletes logged-out reporters' addresses", async () => {
    const filed = await report(
      t.db,
      at(2),
      { contact: "someone@example.test", captchaToken: "ok" },
      { targetType: "post", targetId: postId, reason: "illegal" },
      { verifyCaptcha: passes },
    );
    if (!filed.ok) throw new Error(filed.error);
    await act(mod, {
      action: "remove",
      targetType: "post",
      targetId: postId,
      reason: "Illegal",
      queueItemId: filed.queueItemId,
      version: 1,
    });
    const [row] = await t.db.select().from(reports);
    expect(row!.reporterContact).toBeNull();
  });

  it("a mute until tomorrow refuses posts until then, then lifts", async () => {
    const tomorrow = new Date(at(2).getTime() + 24 * HOUR);
    const muted = await act(mod, {
      action: "mute",
      targetType: "user",
      targetId: author.userId,
      reason: "Cool off",
      until: tomorrow,
    });
    expect(muted).toMatchObject({ ok: true, changed: true });
    const [restriction] = await t.db.select().from(userRestrictions);
    expect(restriction).toMatchObject({
      userId: author.userId,
      kind: "mute",
      until: tomorrow,
      createdBy: mod.userId,
    });
    const during = await reply(t.db, at(3), author, {
      threadId,
      body: "Still here",
    });
    expect(during).toEqual({ ok: false, error: "muted" });
    const after = await reply(
      t.db,
      new Date(tomorrow.getTime() + 60_000),
      author,
      { threadId, body: "Back again" },
    );
    expect(after.ok).toBe(true);
  });

  it("unmute lifts a mute early", async () => {
    await act(mod, {
      action: "mute",
      targetType: "user",
      targetId: author.userId,
      reason: "Cool off",
      until: null,
    });
    await act(
      mod,
      {
        action: "unmute",
        targetType: "user",
        targetId: author.userId,
        reason: "Apologised",
      },
      3,
    );
    const [restriction] = await t.db.select().from(userRestrictions);
    expect(restriction!.liftedAt).toEqual(at(3));
    expect(
      (await reply(t.db, at(4), author, { threadId, body: "Sorry all" })).ok,
    ).toBe(true);
  });

  it("every action writes an audit row with its reason", async () => {
    const steps: ModerateInput[] = [
      {
        action: "lock",
        targetType: "thread",
        targetId: threadId,
        reason: "r1",
      },
      {
        action: "unlock",
        targetType: "thread",
        targetId: threadId,
        reason: "r2",
      },
      { action: "pin", targetType: "thread", targetId: threadId, reason: "r3" },
      {
        action: "unpin",
        targetType: "thread",
        targetId: threadId,
        reason: "r4",
      },
      {
        action: "move",
        targetType: "thread",
        targetId: threadId,
        reason: "r5",
        categoryId: await categoryId(t.db, "race-weekend"),
      },
      {
        action: "retitle",
        targetType: "thread",
        targetId: threadId,
        reason: "r6",
        title: "Monaco: the race",
      },
      { action: "remove", targetType: "post", targetId: postId, reason: "r7" },
      { action: "restore", targetType: "post", targetId: postId, reason: "r8" },
      {
        action: "warn",
        targetType: "user",
        targetId: author.userId,
        reason: "r9",
      },
      {
        action: "chat_ban",
        targetType: "user",
        targetId: author.userId,
        reason: "r10",
        until: at(20),
      },
      {
        action: "mute",
        targetType: "user",
        targetId: author.userId,
        reason: "r11",
        until: at(20),
      },
      {
        action: "unmute",
        targetType: "user",
        targetId: author.userId,
        reason: "r12",
      },
    ];
    for (const [i, step] of steps.entries()) {
      const result = await act(mod, step, 2 + i);
      expect(result, step.action).toMatchObject({ ok: true });
    }
    const audit = await t.db
      .select()
      .from(auditLog)
      .orderBy(auditLog.createdAt);
    expect(audit.map((a) => [a.action, a.reason])).toEqual(
      steps.map((s) => [`moderation.${s.action}`, s.reason]),
    );
    expect(audit[0]).toMatchObject({
      actorUserId: mod.userId,
      actorKind: "moderator",
      entityType: "thread",
      entityId: threadId,
      before: { status: "open" },
      after: { status: "locked" },
    });
    expect(await t.db.select().from(modActions)).toHaveLength(steps.length);
    const thread = await threadRow();
    expect(thread.categoryId).toBe(await categoryId(t.db, "race-weekend"));
  });

  it("retitle changes the spoiler-safe title only", async () => {
    const before = await threadRow();
    expect(before.spoilerSafeTitle).not.toBeNull();
    const result = await act(mod, {
      action: "retitle",
      targetType: "thread",
      targetId: threadId,
      reason: "The safe title gave it away",
      title: "Monaco: the race",
    });
    expect(result).toMatchObject({ ok: true, changed: true });
    const after = await threadRow();
    expect(after.title).toBe("Russell wins in Monaco");
    expect(after.spoilerSafeTitle).toBe("Monaco: the race");
  });

  it("an action on nothing, or the wrong kind of thing, is refused", async () => {
    expect(
      await act(mod, {
        action: "lock",
        targetType: "post",
        targetId: postId,
        reason: "x",
      }),
    ).toEqual({ ok: false, error: "invalid" });
    expect(
      await act(mod, {
        action: "remove",
        targetType: "post",
        targetId: threadId,
        reason: "x",
      }),
    ).toEqual({ ok: false, error: "not_found" });
    expect(
      await act(mod, {
        action: "warn",
        targetType: "user",
        targetId: author.userId,
        reason: "   ",
      }),
    ).toEqual({ ok: false, error: "invalid" });
  });

  it("the author sees the actions taken against them, without who", async () => {
    await act(mod, {
      action: "remove",
      targetType: "post",
      targetId: postId,
      reason: "Ticket spam",
    });
    await act(
      mod,
      {
        action: "mute",
        targetType: "user",
        targetId: author.userId,
        reason: "Repeated spam",
        until: at(20),
      },
      3,
    );
    const seen = await accountActions(t.db, author.userId);
    expect(seen).toEqual([
      {
        action: "mute",
        targetType: "user",
        reason: "Repeated spam",
        until: at(20).toISOString(),
        createdAt: at(3).toISOString(),
      },
      {
        action: "remove",
        targetType: "post",
        reason: "Ticket spam",
        until: null,
        createdAt: at(2).toISOString(),
      },
    ]);
    expect(JSON.stringify(seen)).not.toContain(mod.userId);
    expect(await accountActions(t.db, mod.userId)).toEqual([]);
  });
});
