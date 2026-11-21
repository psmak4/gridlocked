import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import { categoryId, seedViewer } from "../../tests/helpers/community";
import { seedEventSessions } from "../../tests/helpers/sessions";
import {
  broadcasts,
  notificationPreferences,
  notifications,
  profiles,
  sessions,
  users,
} from "@/db/schema";
import type { Viewer } from "@/identity/viewer";
import { moderate, staffActor } from "@/community/moderate";
import { reply } from "@/community/posts";
import { openSessionThreads, postResults } from "@/community/session-threads";
import { createThread } from "@/community/threads";
import { markWatched } from "@/spoilers/reveal";
import { inbox, markRead, unreadCount } from "./read";
import { broadcast, notify } from "./write";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

const NOW = new Date("2026-06-08T12:00:00Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const DAY = 86_400_000;
// Monaco 2026 in the helper: qualifying Saturday, the race Sunday.
const STARTS = [
  new Date("2026-06-05T11:30:00Z"),
  new Date("2026-06-05T15:00:00Z"),
  new Date("2026-06-06T10:30:00Z"),
  new Date("2026-06-06T14:00:00Z"),
  new Date("2026-06-07T13:00:00Z"),
];

describe("notifications (DM 5.11)", () => {
  let t: TestDb;
  let author: Viewer;
  let threadId: string;

  beforeEach(async () => {
    t = await createTestDb();
    author = await seedViewer(t.db, { trustLevel: 1, username: "author" });
    const started = await createThread(t.db, at(0), author, {
      categoryId: await categoryId(t.db, "general"),
      title: "Strategy at Monaco",
      body: "One stop or two?",
    });
    if (!started.ok) throw new Error(started.error);
    threadId = started.threadId;
  });

  afterEach(async () => {
    await t.close();
  });

  const rows = (userId: string) =>
    t.db.select().from(notifications).where(eq(notifications.userId, userId));
  const replier = (n: number) =>
    seedViewer(t.db, { trustLevel: 2, username: `fan${n}` });
  const replyAs = async (
    v: Viewer,
    minute: number,
    body = "Two stops.",
    parentPostId?: string,
  ) => {
    const done = await reply(t.db, at(minute), v, {
      threadId,
      body,
      parentPostId,
    });
    if (!done.ok) throw new Error(done.error);
    return done.postId;
  };

  it("five replies in one thread make one unread row with count 5", async () => {
    for (let i = 1; i <= 5; i++) await replyAs(await replier(i), i);
    const mine = await rows(author.userId);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ kind: "reply", count: 5, readAt: null });

    const [item] = await inbox(t.db, at(10), author);
    expect(item).toMatchObject({
      label: "REPLIES",
      text: "5 new replies in “Strategy at Monaco”",
      href: expect.stringMatching(`^/t/${threadId}`),
      unread: true,
    });
    expect(await unreadCount(t.db, at(10), author)).toBe(1);
  });

  it("a read group starts a new row; one reply names who replied", async () => {
    await replyAs(await replier(1), 1);
    await markRead(t.db, at(2), author, { all: true });
    await replyAs(await replier(2), 3);
    const mine = await rows(author.userId);
    expect(mine).toHaveLength(2);
    const [latest] = await inbox(t.db, at(4), author);
    expect(latest!.text).toBe("fan2 replied in “Strategy at Monaco”");
  });

  it("a reply to a reply tells that reply's author, not the thread's", async () => {
    const fan = await replier(1);
    const postId = await replyAs(fan, 1);
    await replyAs(await replier(2), 2, "Agreed.", postId);
    expect(await rows(fan.userId)).toHaveLength(1);
    expect(await rows(author.userId)).toHaveLength(1); // fan's reply only
  });

  it("a mention is its own notification, and replaces the reply", async () => {
    await replyAs(await replier(1), 1, "What do you think, @author?");
    const mine = await rows(author.userId);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.kind).toBe("mention");
    const [item] = await inbox(t.db, at(2), author);
    expect(item!.text).toBe("fan1 mentioned you in “Strategy at Monaco”");
  });

  it("no one is told about their own reply", async () => {
    await replyAs(author, 1);
    expect(await rows(author.userId)).toHaveLength(0);
  });

  it("a turned-off kind writes no row", async () => {
    await t.db.insert(notificationPreferences).values({
      userId: author.userId,
      kind: "reply",
      channel: "in_app",
      enabled: false,
    });
    await replyAs(await replier(1), 1);
    expect(await rows(author.userId)).toHaveLength(0);
  });

  it("a moderator's removal tells the author, without naming the moderator", async () => {
    const fan = await replier(1);
    const postId = await replyAs(fan, 1);
    const mod = await seedViewer(t.db, { username: "mod", role: "moderator" });
    const done = await moderate(t.db, at(2), staffActor(mod), {
      action: "remove",
      targetType: "post",
      targetId: postId,
      reason: "Off topic",
    });
    expect(done.ok).toBe(true);
    const [item] = await inbox(t.db, at(3), fan);
    expect(item).toMatchObject({
      label: "MODERATION",
      text: "A moderator removed one of your posts. Tap to see why.",
      href: "/profile",
    });
    expect((await rows(fan.userId))[0]!.actorUserId).toBeNull();
  });

  it("notify skips a deleted account", async () => {
    await t.db
      .update(profiles)
      .set({ status: "deleted" })
      .where(eq(profiles.userId, author.userId));
    const id = await notify(t.db, at(1), {
      userId: author.userId,
      kind: "moderation",
      data: { action: "warn" },
    });
    expect(id).toBeNull();
  });

  it("the list keeps 90 days", async () => {
    await notify(t.db, at(0), {
      userId: author.userId,
      kind: "moderation",
      data: { action: "warn" },
    });
    const later = new Date(at(0).getTime() + 91 * DAY);
    expect(await inbox(t.db, later, author)).toHaveLength(0);
    expect(await unreadCount(t.db, later, author)).toBe(0);
  });

  it("a personal notification shows whatever the account's join date says", async () => {
    // A replay clock (M7 Task 16) runs behind the wall clock an account is
    // created on. Only broadcasts need the join date: nothing personal can
    // predate the account.
    await t.db
      .update(users)
      .set({ createdAt: new Date(at(0).getTime() + 30 * DAY) })
      .where(eq(users.id, author.userId));
    await notify(t.db, at(0), {
      userId: author.userId,
      kind: "moderation",
      data: { action: "warn" },
    });
    expect(await inbox(t.db, at(0), author)).toHaveLength(1);
    expect(await unreadCount(t.db, at(0), author)).toBe(1);
  });

  describe("broadcasts", () => {
    let ids: string[];
    beforeEach(async () => {
      ids = await seedEventSessions(t.db, ...STARTS);
      const [row] = await t.db
        .select({ eventId: sessions.eventId })
        .from(sessions)
        .where(eq(sessions.id, ids[0]!));
      await openSessionThreads(
        t.db,
        new Date("2026-06-01T00:00:00Z"),
        row!.eventId,
      );
    });

    it('"scores are in" is one broadcast row', async () => {
      const after = new Date("2026-06-07T16:00:00Z");
      await postResults(t.db, after, ids[4]!);
      await postResults(t.db, after, ids[4]!);
      const rowsNow = await t.db.select().from(broadcasts);
      expect(rowsNow).toHaveLength(1);
      expect(rowsNow[0]).toMatchObject({
        kind: "scores_in",
        sessionId: ids[4],
        dedupeKey: `scores_in:${ids[4]}`,
      });
    });

    const qualifying = () =>
      broadcast(t.db, new Date("2026-06-06T16:00:00Z"), {
        kind: "scores_in",
        sessionId: ids[3]!,
        dedupeKey: `scores_in:${ids[3]}`,
        data: {
          event: "Monaco Grand Prix",
          session: "Qualifying",
          sessionKind: "qualifying",
          leader: "George Russell",
        },
      });

    it('a score notification for a hidden session reads "Qualifying results are in"', async () => {
      await qualifying();
      const [item] = await inbox(t.db, at(0), author);
      expect(item).toMatchObject({
        source: "broadcast",
        label: "SCORES",
        text: "Qualifying results are in for the Monaco Grand Prix.",
        unread: true,
      });
    });

    it("the same notification after Mark as watched names the result", async () => {
      await qualifying();
      await markWatched(t.db, at(0), {
        userId: author.userId,
        sessionIds: [ids[3]!],
      });
      const [item] = await inbox(t.db, at(1), author);
      expect(item!.text).toBe(
        "Monaco Grand Prix qualifying: George Russell took pole. Scores are in.",
      );
    });

    it("Mark all as read clears broadcasts and rows from the count", async () => {
      await qualifying();
      await replyAs(await replier(1), 1);
      expect(await unreadCount(t.db, at(2), author)).toBe(2);
      await markRead(t.db, at(3), author, { all: true });
      expect(await unreadCount(t.db, at(3), author)).toBe(0);
      const items = await inbox(t.db, at(3), author);
      expect(items.map((i) => i.unread)).toEqual([false, false]);
    });

    it("opening one broadcast marks it read", async () => {
      const id = await qualifying();
      await markRead(t.db, at(1), author, { ids: [id!] });
      expect(await unreadCount(t.db, at(1), author)).toBe(0);
    });
  });
});
