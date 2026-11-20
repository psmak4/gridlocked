import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import { seedViewer } from "../../tests/helpers/community";
import { seedEventSessions } from "../../tests/helpers/sessions";
import { chatMessages, sessions, threads } from "@/db/schema";
import type { Viewer } from "@/identity/viewer";
import { chatSince, chatUpTo, sendChat } from "./chat";
import { openSessionThreads } from "./session-threads";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

const RACE = new Date("2026-06-07T13:00:00Z");
const LIVE = new Date("2026-06-07T13:10:00Z");
const MONDAY = new Date("2026-06-01T00:00:00Z");
const seconds = (n: number) => new Date(LIVE.getTime() + n * 1000);

describe("session chat (DM 5.5)", () => {
  let t: TestDb;
  let threadId: string;
  let raceId: string;
  let tl0: Viewer;
  let tl2: Viewer;

  beforeEach(async () => {
    t = await createTestDb();
    const ids = await seedEventSessions(t.db, RACE);
    raceId = ids[0]!;
    const [session] = await t.db
      .select({ eventId: sessions.eventId })
      .from(sessions)
      .where(eq(sessions.id, raceId));
    await openSessionThreads(t.db, MONDAY, session!.eventId);
    threadId = (
      await t.db
        .select({ id: threads.id })
        .from(threads)
        .where(eq(threads.sessionId, raceId))
    )[0]!.id;
    tl0 = await seedViewer(t.db, { trustLevel: 0, username: "new_fan" });
    tl2 = await seedViewer(t.db, { trustLevel: 2, username: "regular" });
  });

  afterEach(async () => {
    await t.close();
  });

  async function send(viewer: Viewer, body: string, at = LIVE) {
    const result = await sendChat(t.db, at, viewer, { threadId, body });
    if (!result.ok) throw new Error(result.error);
    return result.message;
  }

  it("two messages in the same millisecond both arrive, in id order", async () => {
    const first = await send(tl0, "lights out");
    const second = await send(tl2, "and away we go");
    expect(first.createdAt).toBe(second.createdAt);
    expect(first.id < second.id).toBe(true);
    const all = await chatSince(t.db, threadId, null);
    expect(all.map((m) => m.body)).toEqual(["lights out", "and away we go"]);
    expect(all.map((m) => m.author)).toEqual(["new_fan", "regular"]);
    // After the first, only the second.
    expect(
      (await chatSince(t.db, threadId, first.id)).map((m) => m.id),
    ).toEqual([second.id]);
  });

  it("a send outside the chat window is refused with chat_closed", async () => {
    const before = new Date(RACE.getTime() - 16 * 60_000);
    expect(
      await sendChat(t.db, before, tl2, { threadId, body: "too soon" }),
    ).toEqual({ ok: false, error: "chat_closed" });
    // The race runs two hours in the helper; chat closes 15 minutes later,
    // or up to an hour after that while there's no results post.
    const after = new Date(RACE.getTime() + 196 * 60_000);
    expect(
      await sendChat(t.db, after, tl2, { threadId, body: "too late" }),
    ).toEqual({ ok: false, error: "chat_closed" });
    expect(await t.db.select().from(chatMessages)).toHaveLength(0);
  });

  it("slow mode holds TL0 for 10 seconds and says how long is left", async () => {
    await send(tl0, "first");
    expect(
      await sendChat(t.db, seconds(4), tl0, { threadId, body: "second" }),
    ).toEqual({ ok: false, error: "slow_mode", retryAfterSeconds: 6 });
    await send(tl0, "second", seconds(10));
    // TL2 has no slow mode.
    await send(tl2, "a");
    await send(tl2, "b");
  });

  it("a removed message disappears from the next refresh", async () => {
    const kept = await send(tl2, "Box box");
    const gone = await send(tl2, "something rude");
    const end = seconds(3);
    expect((await chatUpTo(t.db, threadId, end)).map((m) => m.id)).toEqual([
      kept.id,
      gone.id,
    ]);
    await t.db
      .update(chatMessages)
      .set({ status: "removed" })
      .where(eq(chatMessages.id, gone.id));
    expect((await chatUpTo(t.db, threadId, end)).map((m) => m.id)).toEqual([
      kept.id,
    ]);
  });

  it("a refresh window shows the latest messages made before its end", async () => {
    for (let i = 0; i < 5; i++) await send(tl2, `m${i}`, seconds(i));
    const upTo = await chatUpTo(t.db, threadId, seconds(3), 2);
    expect(upTo.map((m) => m.body)).toEqual(["m1", "m2"]);
  });

  it("a message's spoiler scope is its thread's session", async () => {
    const message = await send(tl2, "Purple sector");
    const [row] = await t.db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.id, message.id));
    expect(row).toMatchObject({ sessionId: raceId, authorUserId: tl2.userId });
  });
});
