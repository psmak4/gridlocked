import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import { categoryId, seedViewer } from "../../tests/helpers/community";
import { seedEventSessions } from "../../tests/helpers/sessions";
import { posts, profiles, threads } from "@/db/schema";
import type { Viewer } from "@/identity/viewer";
import { markWatched, type Reader } from "@/spoilers/reveal";
import { reply } from "./posts";
import { categoryList, threadList, threadPage } from "./read";
import { createThread } from "./threads";
import { vote } from "./votes";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

// Monaco: qualifying Saturday 14:00, the race Sunday 13:00. It's Sunday
// evening, so both have run and both are inside their spoiler window.
const QUALI = new Date("2026-06-06T14:00:00Z");
const RACE = new Date("2026-06-07T13:00:00Z");
const NOW = new Date("2026-06-07T18:00:00Z");
/** Ten minutes apart, so rate limits never get in the way. */
const at = (step: number) => new Date(NOW.getTime() + step * 600_000);

describe("forum read models", () => {
  let t: TestDb;
  let ada: Viewer;
  let bea: Viewer;
  let raceId: string;
  /** Protection on, nothing watched: the default for a new account. */
  let shielded: Reader;

  beforeEach(async () => {
    t = await createTestDb();
    ada = await seedViewer(t.db, { trustLevel: 1, username: "late_braker" });
    bea = await seedViewer(t.db, { trustLevel: 1, username: "bea" });
    const ids = await seedEventSessions(
      t.db,
      new Date("2026-06-05T11:30:00Z"),
      new Date("2026-06-05T15:00:00Z"),
      new Date("2026-06-06T10:30:00Z"),
      QUALI,
      RACE,
    );
    raceId = ids[4]!;
    shielded = { userId: bea.userId, spoilerProtection: true };
  });

  afterEach(async () => {
    await t.close();
  });

  async function start(
    input: {
      category?: string;
      title?: string;
      body?: string;
      sessionId?: string;
      containsSpoilers?: boolean;
    } = {},
    step = 0,
  ) {
    const r = await createThread(t.db, at(step), ada, {
      categoryId: await categoryId(t.db, input.category ?? "general"),
      title: input.title ?? "Tyre strategy",
      body: input.body ?? "Two stops or one?",
      sessionId: input.sessionId,
      containsSpoilers: input.containsSpoilers,
    });
    if (!r.ok) throw new Error(r.error);
    return r;
  }

  async function answer(
    viewer: Viewer,
    threadId: string,
    body: string,
    step: number,
    parentPostId?: string,
  ) {
    const r = await reply(t.db, at(step), viewer, {
      threadId,
      parentPostId,
      body,
    });
    if (!r.ok) throw new Error(r.error);
    return r.postId;
  }

  const spoilerThread = () =>
    start({
      category: "race-weekend",
      title: "What a win for Ferrari",
      body: "Leclerc at home!",
      sessionId: raceId,
      containsSpoilers: true,
    });

  it("lists the seven categories in order, with today's posts", async () => {
    const { threadId } = await start();
    await answer(bea, threadId, "One stop", 1);
    const list = await categoryList(t.db, at(2));
    expect(list.map((c) => c.slug)).toEqual([
      "race-weekend",
      "fantasy",
      "teams-and-drivers",
      "technical",
      "silly-season",
      "general",
      "off-topic",
    ]);
    expect(list.find((c) => c.slug === "general")).toMatchObject({
      name: "General",
      today: 2,
    });
    expect(list.find((c) => c.slug === "fantasy")?.today).toBe(0);
  });

  it("a hidden thread's list row shows its spoiler-safe title", async () => {
    await spoilerThread();
    const hidden = await threadList(t.db, at(1), shielded, {
      categorySlug: "race-weekend",
      sort: "new",
    });
    expect(hidden?.threads).toEqual([
      expect.objectContaining({
        hidden: true,
        title: "Spoiler thread · Monaco GP race",
        hiddenNote: "Title hidden until you’ve watched the race",
        badge: "spoiler",
      }),
    ]);
    expect(JSON.stringify(hidden)).not.toContain("Ferrari");

    // Logged out is spoiler-safe too (HLD §7.3).
    const loggedOut = await threadList(t.db, at(1), null, {
      categorySlug: "race-weekend",
      sort: "new",
    });
    expect(loggedOut?.threads[0]).toMatchObject({ hidden: true });

    const open = await threadList(
      t.db,
      at(1),
      { userId: bea.userId, spoilerProtection: false },
      { categorySlug: "race-weekend", sort: "new" },
    );
    expect(open?.threads[0]).toMatchObject({
      hidden: false,
      title: "What a win for Ferrari",
      hiddenNote: null,
    });
  });

  it("a hidden thread page returns no posts", async () => {
    const { threadId } = await spoilerThread();
    await answer(bea, threadId, "Forza!", 1);
    const page = await threadPage(t.db, at(2), shielded, { threadId });
    expect(page).toMatchObject({
      hidden: true,
      posts: [],
      thread: {
        title: "Spoiler thread · Monaco GP race",
        sessionId: raceId,
        sessionPhrase: "the race",
      },
    });
    expect(JSON.stringify(page)).not.toMatch(/Ferrari|Leclerc|Forza/);
  });

  it("a reveal returns them", async () => {
    const { threadId } = await spoilerThread();
    await answer(bea, threadId, "Forza!", 1);

    // `?show=` reveals it for this page only.
    const shown = await threadPage(t.db, at(2), shielded, {
      threadId,
      show: [raceId],
    });
    expect(shown?.hidden).toBe(false);
    expect(shown?.thread.title).toBe("What a win for Ferrari");
    expect(shown?.posts.map((p) => p.html)).toEqual([
      "<p>Leclerc at home!</p>",
      "<p>Forza!</p>",
    ]);
    expect(
      (await threadPage(t.db, at(2), shielded, { threadId }))?.hidden,
    ).toBe(true);

    // Marking the race watched reveals it everywhere.
    await markWatched(t.db, at(2), {
      userId: bea.userId,
      sessionIds: [raceId],
    });
    expect(
      (await threadPage(t.db, at(3), shielded, { threadId }))?.hidden,
    ).toBe(false);
  });

  it('a deleted author shows as "deleted user"', async () => {
    const { threadId } = await start();
    await answer(bea, threadId, "One stop", 1);
    await t.db
      .update(profiles)
      .set({ status: "deleted" })
      .where(eq(profiles.userId, bea.userId));
    const page = await threadPage(t.db, at(2), null, { threadId });
    expect(page?.posts.map((p) => p.author)).toEqual([
      "late_braker",
      "deleted user",
    ]);

    await t.db
      .update(profiles)
      .set({ status: "deleted" })
      .where(eq(profiles.userId, ada.userId));
    const list = await threadList(t.db, at(2), null, {
      categorySlug: "general",
      sort: "new",
    });
    expect(list?.threads[0]?.author).toBe("deleted user");
  });

  it('replies deeper than 3 show "Continue thread"', async () => {
    const { threadId } = await start();
    let parent: string | undefined;
    const chain: string[] = [];
    for (let depth = 1; depth <= 5; depth++) {
      parent = await answer(
        depth % 2 ? bea : ada,
        threadId,
        `Level ${depth}`,
        depth,
        parent,
      );
      chain.push(parent);
    }
    const page = await threadPage(t.db, at(6), null, { threadId });
    expect(page?.posts.map((p) => [p.depth, p.moreReplies])).toEqual([
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 2],
    ]);

    // "Continue thread" opens the page at that reply, three levels down.
    const deeper = await threadPage(t.db, at(6), null, {
      threadId,
      postId: chain[2],
    });
    expect(deeper?.focusPostId).toBe(chain[2]);
    expect(deeper?.posts.map((p) => [p.html, p.depth])).toEqual([
      ["<p>Level 3</p>", 1],
      ["<p>Level 4</p>", 2],
      ["<p>Level 5</p>", 3],
    ]);
  });

  it("a deleted reply with answers stays as a placeholder; one without goes", async () => {
    const { threadId } = await start();
    const parent = await answer(bea, threadId, "Hot take", 1);
    await answer(ada, threadId, "Disagree", 2, parent);
    const lonely = await answer(bea, threadId, "Nobody answers", 3);
    const { deleteOwnPost } = await import("./posts");
    await deleteOwnPost(t.db, at(4), bea, { postId: parent });
    await deleteOwnPost(t.db, at(4), bea, { postId: lonely });
    const page = await threadPage(t.db, at(5), null, { threadId });
    expect(page?.posts.map((p) => [p.state, p.html])).toEqual([
      ["visible", "<p>Two stops or one?</p>"],
      ["deleted", null],
      ["visible", "<p>Disagree</p>"],
    ]);
  });

  it("best puts the higher score first, and the reader's own vote comes back", async () => {
    const { threadId } = await start();
    const first = await answer(bea, threadId, "First", 1);
    const second = await answer(bea, threadId, "Second", 2);
    await vote(t.db, at(3), ada, { postId: second, value: 1 });
    const reader: Reader = { userId: ada.userId, spoilerProtection: true };
    const best = await threadPage(t.db, at(4), reader, {
      threadId,
      sort: "best",
    });
    expect(best?.posts.slice(1).map((p) => [p.id, p.myVote, p.mine])).toEqual([
      [second, 1, false],
      [first, 0, false],
    ]);
    expect(best?.posts[0]?.mine).toBe(true);
    const latest = await threadPage(t.db, at(4), reader, {
      threadId,
      sort: "new",
    });
    expect(latest?.posts.slice(1).map((p) => p.id)).toEqual([second, first]);
  });

  it("a held thread is listed for its author only, and a removed one for nobody", async () => {
    const held = await start({ title: "Held one" }, 0);
    await t.db
      .update(posts)
      .set({ status: "pending_review" })
      .where(eq(posts.id, held.postId));
    const gone = await start({ title: "Removed one", body: "Bye" }, 1);
    await t.db
      .update(threads)
      .set({ status: "removed" })
      .where(eq(threads.id, gone.threadId));
    const titles = async (reader: Reader) =>
      (
        await threadList(t.db, at(2), reader, {
          categorySlug: "general",
          sort: "new",
        })
      )?.threads.map((r) => r.title);
    expect(await titles(null)).toEqual([]);
    expect(
      await titles({ userId: ada.userId, spoilerProtection: true }),
    ).toEqual(["Held one"]);
    expect(
      await threadPage(t.db, at(2), null, { threadId: gone.threadId }),
    ).toBeNull();
    expect(
      await threadList(t.db, at(2), null, {
        categorySlug: "nope",
        sort: "new",
      }),
    ).toBeNull();
  });
});
