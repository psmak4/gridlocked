import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import { categoryId, seedViewer } from "../../tests/helpers/community";
import { modQueueItems, posts, profiles } from "@/db/schema";
import type { Viewer } from "@/identity/viewer";
import { moderate, staffActor, type ModTargetType } from "./moderate";
import { report, type CaptchaVerifier } from "./moderation";
import { editPost, reply } from "./posts";
import { modItem, modQueue, openModCount } from "./queue-read";
import { createThread } from "./threads";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

const NOW = new Date("2026-03-07T12:00:00Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
const passes: CaptchaVerifier = async () => true;

// The moderation queue's reads (M8 Task 11): the tabs, and one item with its
// snapshot, reports and the author's history.
describe("modQueue and modItem (M8 Task 11)", () => {
  let t: TestDb;
  let author: Viewer;
  let mod: Viewer;
  let threadId: string;
  let postId: string;

  beforeEach(async () => {
    t = await createTestDb();
    author = await seedViewer(t.db, { trustLevel: 1, username: "Author" });
    mod = await seedViewer(t.db, { username: "mod", role: "moderator" });
    const started = await createThread(t.db, at(0), author, {
      categoryId: await categoryId(t.db, "general"),
      title: "Race thoughts",
      body: "What a drive.",
      containsSpoilers: false,
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

  /** A report on the reply by a reader of `trustLevel`. */
  async function reportReply(
    trustLevel: number,
    reason: "spam" | "abuse" = "spam",
    username = `reader${trustLevel}${reason}`,
  ) {
    const reader = await seedViewer(t.db, { trustLevel, username });
    const filed = await report(
      t.db,
      at(2),
      reader,
      { targetType: "post", targetId: postId, reason },
      { verifyCaptcha: passes },
    );
    if (!filed.ok) throw new Error(filed.error);
    return filed;
  }

  it("modItem shows the snapshot at first report even after the post is edited", async () => {
    const filed = await reportReply(0);
    const edited = await editPost(t.db, at(3), author, {
      postId,
      body: "Tickets, but nicer",
    });
    expect(edited).toMatchObject({ ok: true });

    const item = await modItem(t.db, filed.queueItemId);
    expect(item).toMatchObject({
      type: "post",
      where: "Race thoughts",
      snapshot: { body: "Buy cheap tickets" },
      byReason: [{ reason: "spam", count: 1 }],
      version: expect.any(Number),
    });
    expect(item!.snapshot.edits).toEqual([
      expect.objectContaining({ body: "Tickets, but nicer" }),
    ]);
    expect(item!.actions.map((a) => a.label)).toEqual([
      "Remove post",
      "Mute the author for 7 days",
      "Keep it, close reports",
    ]);
  });

  it("modItem's author history counts earlier actions from mod_actions", async () => {
    // An earlier warning, not about this item.
    await moderate(t.db, at(1), staffActor(mod), {
      action: "warn",
      targetType: "user",
      targetId: author.userId,
      reason: "Keep it civil",
    });
    const filed = await reportReply(0);
    const item = await modItem(t.db, filed.queueItemId);
    expect(item!.author).toMatchObject({
      username: "Author",
      trustLevel: 1,
      posts: 2,
      earlier: 1,
    });
    expect(item!.author.joined).toMatch(/\S/);
  });

  it('"Keep it, close reports" dismisses the item and restores auto-hidden content', async () => {
    const filed = await reportReply(3);
    expect(filed.hidden).toBe(true);
    const item = await modItem(t.db, filed.queueItemId);
    const keep = item!.actions.at(-1)!;
    expect(keep).toMatchObject({ action: "restore" });

    const done = await moderate(t.db, at(4), staffActor(mod), {
      action: keep.action,
      targetType: item!.type as ModTargetType,
      targetId: item!.targetId,
      reason: "Not spam",
      queueItemId: item!.id,
      version: item!.version,
    });
    expect(done).toMatchObject({ ok: true });
    const [post] = await t.db.select().from(posts).where(eq(posts.id, postId));
    expect(post!.status).toBe("visible");
    const [row] = await t.db
      .select()
      .from(modQueueItems)
      .where(eq(modQueueItems.id, item!.id));
    expect(row!.status).toBe("dismissed");
    expect((await modQueue(t.db, { tab: "done" })).map((i) => i.id)).toEqual([
      item!.id,
    ]);
  });

  it("the Auto-hidden tab lists open items whose content is hidden_by_flags", async () => {
    // A thread reported once by a newcomer: open, still shown.
    const other = await seedViewer(t.db, { trustLevel: 0, username: "newbie" });
    const shown = await report(
      t.db,
      at(2),
      other,
      { targetType: "thread", targetId: threadId, reason: "abuse" },
      { verifyCaptcha: passes },
    );
    if (!shown.ok) throw new Error(shown.error);
    // The reply reported by a regular: hidden at once.
    const hidden = await reportReply(3);

    const open = await modQueue(t.db, { tab: "open" });
    expect(open.map((i) => i.id).sort()).toEqual(
      [shown.queueItemId, hidden.queueItemId].sort(),
    );
    const autoHidden = await modQueue(t.db, { tab: "hidden" });
    expect(autoHidden.map((i) => i.id)).toEqual([hidden.queueItemId]);
    expect(autoHidden[0]).toMatchObject({
      state: "Auto-hidden",
      reason: "spam",
      type: "post",
      snippet: "Buy cheap tickets",
      where: "Race thoughts",
      reports: 1,
    });
  });

  it("the staff area's counts come from count queries", async () => {
    expect(await openModCount(t.db)).toBe(0);
    const other = await seedViewer(t.db, { trustLevel: 0, username: "newbie" });
    const shown = await report(
      t.db,
      at(2),
      other,
      { targetType: "thread", targetId: threadId, reason: "abuse" },
      { verifyCaptcha: passes },
    );
    if (!shown.ok) throw new Error(shown.error);
    await reportReply(3);
    expect(await openModCount(t.db)).toBe(2);

    // A closed item no longer counts.
    await t.db
      .update(modQueueItems)
      .set({ status: "dismissed" })
      .where(eq(modQueueItems.id, shown.queueItemId));
    expect(await openModCount(t.db)).toBe(1);
    expect(await openModCount(t.db)).toBe(
      (await modQueue(t.db, { tab: "open" })).length,
    );
  });

  it("a deleted author shows as deleted user", async () => {
    const filed = await reportReply(0);
    await t.db
      .update(profiles)
      .set({ status: "deleted" })
      .where(eq(profiles.userId, author.userId));
    const item = await modItem(t.db, filed.queueItemId);
    expect(item!.author.username).toBe("deleted user");
  });
});
