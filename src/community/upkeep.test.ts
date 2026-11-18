import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import { categoryId, seedViewer } from "../../tests/helpers/community";
import {
  modActions,
  modQueueItems,
  notifications,
  postRevisions,
  profiles,
  reports,
  threads,
} from "@/db/schema";
import { recomputeTrustLevels } from "@/identity/trust";
import type { Viewer } from "@/identity/viewer";
import { newId } from "@/lib/ids";
import { notify } from "@/notifications/write";
import { reply } from "./posts";
import { createThread } from "./threads";
import {
  forumTrustCounts,
  hotRank,
  pruneCommunity,
  recomputeReputation,
  refreshHotRank,
} from "./upkeep";
import { vote } from "./votes";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

const NOW = new Date("2026-07-08T06:00:00Z");
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

describe("community upkeep (DM 5.6, 5.10)", () => {
  let t: TestDb;
  let author: Viewer;
  let threadId: string;
  let openingId: string;

  beforeEach(async () => {
    t = await createTestDb();
    author = await seedViewer(t.db, { trustLevel: 1, username: "author" });
    const started = await createThread(t.db, daysAgo(1), author, {
      categoryId: await categoryId(t.db),
      title: "Strategy at Monaco",
      body: "One stop or two?",
    });
    if (!started.ok) throw new Error(started.error);
    threadId = started.threadId;
    openingId = started.postId;
  });

  afterEach(async () => {
    await t.close();
  });

  const reputationOf = async (userId: string) =>
    (
      await t.db
        .select({ reputation: profiles.reputation })
        .from(profiles)
        .where(eq(profiles.userId, userId))
    )[0]!.reputation;

  it("a TL0 upvote adds no reputation", async () => {
    const newcomer = await seedViewer(t.db, { trustLevel: 0, username: "new" });
    const regular = await seedViewer(t.db, { trustLevel: 1, username: "reg" });
    await vote(t.db, NOW, newcomer, { postId: openingId, value: 1 });
    await recomputeReputation(t.db);
    expect(await reputationOf(author.userId)).toBe(0);

    await vote(t.db, NOW, regular, { postId: openingId, value: 1 });
    await recomputeReputation(t.db);
    expect(await reputationOf(author.userId)).toBe(1);
  });

  it("ten posts and three days lift a user to TL1", async () => {
    const fan = await seedViewer(t.db, { trustLevel: 0, username: "fan" });
    await t.db
      .update(profiles)
      .set({ daysVisited: 3, lastSeenAt: daysAgo(0) })
      .where(eq(profiles.userId, fan.userId));
    for (let i = 0; i < 9; i++) {
      const done = await reply(t.db, daysAgo(0.9 - i * 0.05), fan, {
        threadId,
        body: `Reply number ${i}`,
      });
      if (!done.ok) throw new Error(done.error);
    }
    const level = async () =>
      (
        await t.db
          .select({ trust: profiles.trustLevel })
          .from(profiles)
          .where(eq(profiles.userId, fan.userId))
      )[0]!.trust;

    await recomputeTrustLevels(t.db, NOW, { counts: forumTrustCounts });
    expect(await level()).toBe(0);
    const tenth = await reply(t.db, daysAgo(0.1), fan, {
      threadId,
      body: "Reply number 9",
    });
    if (!tenth.ok) throw new Error(tenth.error);
    await recomputeTrustLevels(t.db, NOW, { counts: forumTrustCounts });
    expect(await level()).toBe(1);
  });

  it("a 1-year-old revision is pruned and a 364-day one isn't", async () => {
    await t.db.insert(postRevisions).values([
      {
        id: newId(),
        postId: openingId,
        body: "old",
        editedAt: daysAgo(365),
        editedBy: author.userId,
      },
      {
        id: newId(),
        postId: openingId,
        body: "newer",
        editedAt: daysAgo(364),
        editedBy: author.userId,
      },
    ]);
    await pruneCommunity(t.db, NOW);
    const left = await t.db.select().from(postRevisions);
    expect(left.map((r) => r.body)).toEqual(["newer"]);
  });

  it("notifications older than 90 days go", async () => {
    for (const at of [daysAgo(91), daysAgo(89)]) {
      await notify(t.db, at, {
        userId: author.userId,
        kind: "moderation",
        data: { action: "warn" },
      });
    }
    await pruneCommunity(t.db, NOW);
    const left = await t.db.select().from(notifications);
    expect(left.map((n) => n.createdAt)).toEqual([daysAgo(89)]);
  });

  it("resolved reports, queue items and actions go after 2 years; open ones stay", async () => {
    const item = async (
      status: "open" | "actioned",
      resolvedAt: Date | null,
    ) => {
      const id = newId();
      await t.db.insert(modQueueItems).values({
        id,
        targetType: "post",
        targetId: newId(),
        source: "reports",
        contentSnapshot: { body: "x" },
        status,
        resolvedAt,
        createdAt: resolvedAt ?? NOW,
      });
      await t.db.insert(reports).values({
        id: newId(),
        queueItemId: id,
        targetType: "post",
        targetId: newId(),
        reason: "spam",
        weight: 1,
        createdAt: resolvedAt ?? NOW,
      });
      return id;
    };
    const old = await item("actioned", daysAgo(731));
    const recent = await item("actioned", daysAgo(700));
    const open = await item("open", null);
    await t.db.insert(modActions).values({
      id: newId(),
      action: "remove",
      targetType: "post",
      targetId: newId(),
      reason: "spam",
      queueItemId: old,
      createdAt: daysAgo(731),
    });

    await pruneCommunity(t.db, NOW);
    const items = (await t.db.select().from(modQueueItems)).map((i) => i.id);
    expect(items.sort()).toEqual([recent, open].sort());
    expect(await t.db.select().from(reports)).toHaveLength(2);
    expect(await t.db.select().from(modActions)).toHaveLength(0);
  });

  it("hot rank orders a 50-point thread from today above a 60-point one from last week", () => {
    expect(hotRank(50, NOW)).toBeGreaterThan(hotRank(60, daysAgo(7)));
    expect(hotRank(-5, NOW)).toBeLessThan(hotRank(0, NOW));
  });

  it("a vote moves the thread's hot rank, and the sweep agrees", async () => {
    const [before] = await t.db
      .select({ hot: threads.hotRank, created: threads.createdAt })
      .from(threads)
      .where(eq(threads.id, threadId));
    expect(before!.hot).toBeCloseTo(hotRank(0, before!.created), 3);
    const regular = await seedViewer(t.db, { trustLevel: 1, username: "reg" });
    await vote(t.db, NOW, regular, { postId: openingId, value: 1 });
    const [after] = await t.db
      .select({ hot: threads.hotRank })
      .from(threads)
      .where(eq(threads.id, threadId));
    expect(after!.hot).toBeCloseTo(hotRank(1, before!.created), 3);

    await t.db.update(threads).set({ hotRank: 0 });
    expect(await refreshHotRank(t.db, NOW)).toBe(1);
    const [swept] = await t.db
      .select({ hot: threads.hotRank })
      .from(threads)
      .where(eq(threads.id, threadId));
    expect(swept!.hot).toBeCloseTo(hotRank(1, before!.created), 3);
  });
});
