import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import { loadCalendar2026 } from "../../tests/helpers/calendar-2026";
import { seedEventSessions } from "../../tests/helpers/sessions";
import {
  categories,
  events,
  jobs,
  posts,
  sessions,
  settings,
  threads,
} from "@/db/schema";
import { SYSTEM_USER_ID } from "@/identity/system";
import { planEventJobs } from "@/jobs/plan-event";
import { simulatedClock } from "@/lib/clock";
import { newId } from "@/lib/ids";
import { syncCalendar } from "@/reference/sync-calendar";
import { chatRefreshResponse } from "@/server/chat-refresh";
import type { ServerDb } from "@/server/db";
import { seedViewer } from "../../tests/helpers/community";
import { sendChat } from "./chat";
import { threadPage } from "./read";
import {
  chatWindow,
  openSessionThreads,
  postResults,
  threadMode,
} from "./session-threads";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

const MIN = 60_000;
// Monaco 2026 in the helper: Friday 5 June to Sunday 7 June.
const STARTS = [
  new Date("2026-06-05T11:30:00Z"),
  new Date("2026-06-05T15:00:00Z"),
  new Date("2026-06-06T10:30:00Z"),
  new Date("2026-06-06T14:00:00Z"),
  new Date("2026-06-07T13:00:00Z"),
];
const MONDAY = new Date("2026-06-01T00:00:00Z");

describe("session threads", () => {
  let t: TestDb;
  let ids: string[];
  let eventId: string;

  beforeEach(async () => {
    t = await createTestDb();
    ids = await seedEventSessions(t.db, ...STARTS);
    eventId = (
      await t.db
        .select({ eventId: sessions.eventId })
        .from(sessions)
        .where(eq(sessions.id, ids[0]!))
    )[0]!.eventId;
  });

  afterEach(async () => {
    await t.close();
  });

  const sessionThreads = () =>
    t.db
      .select()
      .from(threads)
      .where(eq(threads.kind, "session"))
      .orderBy(asc(threads.chatOpensAt));

  it("event week opens one thread per session on Monday 00:00 UTC", async () => {
    await planEventJobs(t.db, eventId);
    const [job] = await t.db
      .select()
      .from(jobs)
      .where(eq(jobs.dedupeKey, `open_threads:${eventId}`));
    expect(job).toMatchObject({
      kind: "open_threads",
      runAt: MONDAY,
      payload: { eventId },
    });

    await openSessionThreads(t.db, MONDAY, eventId);
    const rows = await sessionThreads();
    const [raceWeekend] = await t.db
      .select({ id: categories.id })
      .from(categories)
      .where(eq(categories.slug, "race-weekend"));
    expect(rows.map((r) => r.title)).toEqual([
      "Monaco GP · Practice 1",
      "Monaco GP · Practice 2",
      "Monaco GP · Practice 3",
      "Monaco GP · Qualifying",
      "Monaco GP · Race",
    ]);
    expect(rows[4]).toMatchObject({
      categoryId: raceWeekend!.id,
      sessionId: ids[4],
      eventId,
      authorUserId: null,
      containsSpoilers: true,
      spoilerSafeTitle: "Monaco GP · Race",
      chatOpensAt: new Date(STARTS[4]!.getTime() - 15 * MIN),
      chatClosesAt: new Date(STARTS[4]!.getTime() + 135 * MIN),
      status: "open",
    });
    // Each has its opening post, from the system account.
    const openings = await t.db
      .select({ author: posts.authorUserId, sessionId: posts.sessionId })
      .from(posts)
      .where(eq(posts.isOpening, true));
    expect(openings).toHaveLength(5);
    expect(new Set(openings.map((p) => p.author))).toEqual(
      new Set([SYSTEM_USER_ID]),
    );
  });

  it("running the job twice makes no second thread", async () => {
    await openSessionThreads(t.db, MONDAY, eventId);
    await openSessionThreads(t.db, MONDAY, eventId);
    expect(await sessionThreads()).toHaveLength(5);
    expect(await t.db.select().from(posts)).toHaveLength(5);
  });

  it("a cancelled session gets no thread", async () => {
    await t.db
      .update(sessions)
      .set({ status: "cancelled" })
      .where(eq(sessions.id, ids[0]!));
    await openSessionThreads(t.db, MONDAY, eventId);
    expect((await sessionThreads()).map((r) => r.sessionId)).not.toContain(
      ids[0],
    );
  });

  it("chatWindow is 15 minutes either side", () => {
    expect(
      chatWindow({
        scheduledStart: new Date("2026-06-07T13:00:00Z"),
        scheduledEnd: new Date("2026-06-07T15:00:00Z"),
      }),
    ).toEqual({
      opensAt: new Date("2026-06-07T12:45:00Z"),
      closesAt: new Date("2026-06-07T15:15:00Z"),
    });
  });

  it("a suspended session stays in chat mode past chat_closes_at", () => {
    const thread = {
      chatOpensAt: new Date("2026-06-07T12:45:00Z"),
      chatClosesAt: new Date("2026-06-07T15:15:00Z"),
    };
    const at = (iso: string) => new Date(iso);
    expect(
      threadMode(at("2026-06-07T12:44:00Z"), { status: "scheduled" }, thread),
    ).toBe("discussion");
    expect(
      threadMode(at("2026-06-07T12:45:00Z"), { status: "scheduled" }, thread),
    ).toBe("chat");
    expect(
      threadMode(at("2026-06-07T15:15:00Z"), { status: "live" }, thread),
    ).toBe("discussion");
    expect(
      threadMode(at("2026-06-07T17:00:00Z"), { status: "suspended" }, thread),
    ).toBe("chat");
    // A user thread has no window.
    expect(
      threadMode(at("2026-06-07T13:00:00Z"), null, {
        chatOpensAt: null,
        chatClosesAt: null,
      }),
    ).toBe("discussion");
  });

  it("a cancelled session's thread is discussion and gets no results post", async () => {
    await openSessionThreads(t.db, MONDAY, eventId);
    await t.db
      .update(sessions)
      .set({ status: "cancelled" })
      .where(eq(sessions.id, ids[4]!));
    const [race] = await t.db
      .select()
      .from(threads)
      .where(eq(threads.sessionId, ids[4]!));
    expect(threadMode(STARTS[4]!, { status: "cancelled" }, race!)).toBe(
      "discussion",
    );
    const page = await threadPage(t.db, STARTS[4]!, null, {
      threadId: race!.id,
    });
    expect(page?.mode).toBe("discussion");

    await postResults(t.db, new Date("2026-06-07T16:00:00Z"), ids[4]!);
    expect(
      await t.db.select().from(posts).where(eq(posts.threadId, race!.id)),
    ).toHaveLength(1);
  });

  it("with chat off, a session thread in its window is in discussion mode and the refresh answers 404", async () => {
    await openSessionThreads(t.db, MONDAY, eventId);
    const [race] = await t.db
      .select()
      .from(threads)
      .where(eq(threads.sessionId, ids[4]!));
    const live = new Date(STARTS[4]!.getTime() + 10 * MIN);
    // Chat on: the window is open.
    expect(
      (await threadPage(t.db, live, null, { threadId: race!.id }))?.mode,
    ).toBe("chat");

    await t.db
      .insert(settings)
      .values({ key: "feature_flags", value: { chat: false, push: true } });
    expect(
      (await threadPage(t.db, live, null, { threadId: race!.id }))?.mode,
    ).toBe("discussion");
    const fan = await seedViewer(t.db, { trustLevel: 2, username: "fan" });
    expect(
      await sendChat(t.db, live, fan, { threadId: race!.id, body: "Go!" }),
    ).toMatchObject({ ok: false, error: "chat_closed" });
    const windowStart = new Date(Math.floor(live.getTime() / 3000) * 3000);
    const refresh = await chatRefreshResponse(
      new Request(
        `http://localhost/api/chat/${race!.id}?after=${windowStart.toISOString()}`,
      ),
      race!.id,
      (fn) => fn(t.db as unknown as ServerDb, live),
    );
    expect(refresh.status).toBe(404);
  });

  it("a page read before chat opens says when it does", async () => {
    await openSessionThreads(t.db, MONDAY, eventId);
    const [race] = await t.db
      .select()
      .from(threads)
      .where(eq(threads.sessionId, ids[4]!));
    const page = (iso: string) =>
      threadPage(t.db, new Date(iso), null, {
        threadId: race!.id,
        showAll: true,
      });
    expect(await page("2026-06-07T12:00:00Z")).toMatchObject({
      mode: "discussion",
      opensChatAt: "2026-06-07T12:45:00.000Z",
    });
    expect((await page("2026-06-07T12:50:00Z"))?.opensChatAt).toBeNull();
  });

  it("past its window, chat waits for the results post, for an hour at most", async () => {
    await openSessionThreads(t.db, MONDAY, eventId);
    const [race] = await t.db
      .select()
      .from(threads)
      .where(eq(threads.sessionId, ids[4]!));
    const mode = async (iso: string) =>
      (
        await threadPage(t.db, new Date(iso), null, {
          threadId: race!.id,
          showAll: true,
        })
      )?.mode;
    // The window closes at 15:15; a long red flag runs the race past it.
    expect(race!.chatClosesAt).toEqual(new Date("2026-06-07T15:15:00Z"));
    expect(await mode("2026-06-07T15:40:00Z")).toBe("chat");
    // No results an hour after the window: discussion all the same.
    expect(await mode("2026-06-07T16:15:00Z")).toBe("discussion");
    // The results post ends it.
    await postResults(t.db, new Date("2026-06-07T15:45:00Z"), ids[4]!);
    expect(await mode("2026-06-07T15:46:00Z")).toBe("discussion");
  });

  it("the results post is a link, and its thread is spoiler-scoped", async () => {
    await openSessionThreads(t.db, MONDAY, eventId);
    const after = new Date("2026-06-07T16:00:00Z");
    await postResults(t.db, after, ids[4]!);
    await postResults(t.db, after, ids[4]!);
    const [race] = await t.db
      .select()
      .from(threads)
      .where(eq(threads.sessionId, ids[4]!));
    const replies = await t.db
      .select()
      .from(posts)
      .where(and(eq(posts.threadId, race!.id), eq(posts.isOpening, false)));
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({
      authorUserId: SYSTEM_USER_ID,
      sessionId: ids[4],
      containsSpoilers: true,
      depth: 1,
      status: "visible",
    });

    // Hidden from anyone who hasn't watched; a link once revealed.
    const shielded = await threadPage(t.db, after, null, {
      threadId: race!.id,
    });
    expect(shielded).toMatchObject({
      hidden: true,
      posts: [],
      thread: { title: "Monaco GP · Race" },
    });
    const shown = await threadPage(t.db, after, null, {
      threadId: race!.id,
      show: [ids[4]!],
    });
    const html = shown!.posts.find((p) => !p.isOpening)!.html!;
    expect(html).toContain('<a href="/weekend">Results and points</a>');
  });

  it("a 30-minute delay moves the chat window", async () => {
    const clock = simulatedClock(new Date("2026-02-01T00:00:00Z"));
    const sync = (list: ReturnType<typeof loadCalendar2026>) =>
      syncCalendar(t.db, clock, 2026, { events: list, snapshotId: newId() });
    await sync(loadCalendar2026());
    const [australia] = await t.db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.name, "Australian Grand Prix"));
    await openSessionThreads(t.db, clock.now(), australia!.id);

    const list = loadCalendar2026();
    const quali = list[0]!.sessions.find((s) => s.kind === "qualifying")!;
    const before = quali.start;
    quali.start = new Date(quali.start.getTime() + 30 * MIN);
    await sync(list);

    const [session] = await t.db
      .select()
      .from(sessions)
      .where(
        and(
          eq(sessions.eventId, australia!.id),
          eq(sessions.kind, "qualifying"),
        ),
      );
    const [thread] = await t.db
      .select()
      .from(threads)
      .where(eq(threads.sessionId, session!.id));
    expect(thread!.chatOpensAt).toEqual(new Date(before.getTime() + 15 * MIN));
    expect(thread!.chatClosesAt).toEqual(
      new Date(session!.scheduledEnd.getTime() + 15 * MIN),
    );
  });
});
