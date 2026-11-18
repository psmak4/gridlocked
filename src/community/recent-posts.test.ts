import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import { categoryId, seedViewer } from "../../tests/helpers/community";
import type { Viewer } from "@/identity/viewer";
import { reply } from "./posts";
import { recentPosts } from "./read";
import { createThread } from "./threads";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

const NOW = new Date("2026-07-08T06:00:00Z");
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(NOW.getTime() - n * DAY);

describe("recent posts on the profile", () => {
  let t: TestDb;
  let me: Viewer;
  let other: Viewer;

  beforeEach(async () => {
    t = await createTestDb();
    me = await seedViewer(t.db, { trustLevel: 1, username: "me" });
    other = await seedViewer(t.db, { trustLevel: 1, username: "other" });
  });

  afterEach(async () => {
    await t.close();
  });

  async function thread(by: Viewer, at: Date, title: string, spoilers = false) {
    const started = await createThread(t.db, at, by, {
      categoryId: await categoryId(t.db),
      title,
      body: `Opening of ${title}`,
      containsSpoilers: spoilers,
    });
    if (!started.ok) throw new Error(started.error);
    return started.threadId;
  }

  it("lists my last five posts, newest first, and nobody else's", async () => {
    const threadId = await thread(other, daysAgo(20), "Pit stops");
    for (let i = 0; i < 6; i++) {
      const done = await reply(t.db, daysAgo(10 - i), me, {
        threadId,
        body: `My reply ${i}`,
      });
      if (!done.ok) throw new Error(done.error);
    }
    await reply(t.db, daysAgo(1), other, { threadId, body: "Theirs" });

    const recent = await recentPosts(t.db, NOW, me);
    expect(recent).toHaveLength(5);
    expect(recent.map((p) => p.excerpt)).toEqual([
      "My reply 5",
      "My reply 4",
      "My reply 3",
      "My reply 2",
      "My reply 1",
    ]);
    expect(recent[0]).toMatchObject({
      threadId,
      title: "Pit stops",
      href: expect.stringMatching(new RegExp(`^/t/${threadId}#post-`)),
    });
  });

  it("a spoiler thread's title stays hidden in the list", async () => {
    const threadId = await thread(other, daysAgo(1), "Verstappen wins", true);
    const done = await reply(t.db, daysAgo(0.5), me, {
      threadId,
      body: "Called it",
    });
    if (!done.ok) throw new Error(done.error);

    const [post] = await recentPosts(t.db, NOW, me);
    expect(post!.title).not.toContain("Verstappen");
  });
});
