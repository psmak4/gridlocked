import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gunzipSync } from "node:zlib";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import { seedViewer } from "../../tests/helpers/community";
import { seedEventSessions } from "../../tests/helpers/sessions";
import { createMemoryChatArchiveStore } from "../../tests/helpers/memory-chat-archive-store";
import {
  chatArchives,
  chatMessages,
  modQueueItems,
  sessions,
  threads,
} from "@/db/schema";
import { buildExport } from "@/identity/export";
import type { Viewer } from "@/identity/viewer";
import {
  archiveDueChats,
  archiveThreadChat,
  chatArchiveKey,
  chatReplay,
  type ChatArchiveStore,
} from "./archive";
import { sendChat } from "./chat";
import { report } from "./moderation";
import { openSessionThreads } from "./session-threads";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

const DAY = 24 * 60 * 60 * 1000;
const RACE = new Date("2026-06-07T13:00:00Z");
// The race runs two hours in the helper.
const END = new Date(RACE.getTime() + 2 * 60 * 60 * 1000);
const LIVE = new Date("2026-06-07T13:10:00Z");
const daysAfter = (n: number) => new Date(END.getTime() + n * DAY);

describe("the chat archive (DM 5.5)", () => {
  let t: TestDb;
  let threadId: string;
  let fan: Viewer;
  let other: Viewer;
  let memory: ReturnType<typeof createMemoryChatArchiveStore>;

  beforeEach(async () => {
    t = await createTestDb();
    const [raceId] = await seedEventSessions(t.db, RACE);
    const [session] = await t.db
      .select({ eventId: sessions.eventId })
      .from(sessions)
      .where(eq(sessions.id, raceId!));
    await openSessionThreads(
      t.db,
      new Date("2026-06-01T00:00:00Z"),
      session!.eventId,
    );
    threadId = (
      await t.db
        .select({ id: threads.id })
        .from(threads)
        .where(eq(threads.sessionId, raceId!))
    )[0]!.id;
    fan = await seedViewer(t.db, { trustLevel: 2, username: "fan" });
    other = await seedViewer(t.db, { trustLevel: 2, username: "other" });
    for (const [viewer, body, s] of [
      [fan, "Lights out", 0],
      [other, "Great start", 1],
      [fan, "Safety car!", 2],
    ] as const) {
      const sent = await sendChat(
        t.db,
        new Date(LIVE.getTime() + s * 1000),
        viewer,
        { threadId, body },
      );
      if (!sent.ok) throw new Error(sent.error);
    }
    memory = createMemoryChatArchiveStore();
  });

  afterEach(async () => {
    await t.close();
  });

  const rows = () =>
    t.db.select().from(chatMessages).where(eq(chatMessages.threadId, threadId));
  const fileLines = () =>
    gunzipSync(memory.objects.get(chatArchiveKey(threadId))!)
      .toString("utf8")
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  it("archiving 29 days after the session does nothing", async () => {
    expect(
      await archiveThreadChat(t.db, memory.store, daysAfter(29), threadId),
    ).toBe("not_due");
    expect(await archiveDueChats(t.db, memory.store, daysAfter(29))).toBe(0);
    expect(memory.puts).toEqual([]);
    expect(await rows()).toHaveLength(3);
  });

  it("at 30 days the file holds every visible message and the rows are gone", async () => {
    expect(await archiveDueChats(t.db, memory.store, daysAfter(30))).toBe(1);
    const lines = fileLines();
    expect(lines.map((l) => l.body)).toEqual([
      "Lights out",
      "Great start",
      "Safety car!",
    ]);
    // Only the id, the author's id, the time and the text.
    expect(Object.keys(lines[0]!).sort()).toEqual([
      "authorUserId",
      "body",
      "createdAt",
      "id",
    ]);
    expect(lines[0]).toMatchObject({ authorUserId: fan.userId });
    expect(await rows()).toHaveLength(0);
    const [archive] = await t.db
      .select()
      .from(chatArchives)
      .where(eq(chatArchives.threadId, threadId));
    expect(archive).toMatchObject({
      objectKey: chatArchiveKey(threadId),
      messageCount: 3,
      firstMessageAt: LIVE,
      archivedAt: daysAfter(30),
    });
    // And again: nothing more.
    expect(await archiveDueChats(t.db, memory.store, daysAfter(31))).toBe(0);
  });

  it("the chat archive closes an open queue item about a message it archives, as dismissed, and keeps its snapshot", async () => {
    const [message] = await rows();
    const reporter = await seedViewer(t.db, {
      trustLevel: 1,
      username: "reporter",
    });
    const filed = await report(
      t.db,
      LIVE,
      reporter,
      { targetType: "chat_message", targetId: message!.id, reason: "abuse" },
      { verifyCaptcha: async () => true },
    );
    if (!filed.ok) throw new Error(filed.error);
    const before = (
      await t.db
        .select()
        .from(modQueueItems)
        .where(eq(modQueueItems.id, filed.queueItemId))
    )[0]!;

    expect(
      await archiveThreadChat(t.db, memory.store, daysAfter(30), threadId),
    ).toBe("archived");
    const [after] = await t.db
      .select()
      .from(modQueueItems)
      .where(eq(modQueueItems.id, filed.queueItemId));
    expect(after).toMatchObject({
      status: "dismissed",
      resolution: "archived before review",
      resolvedAt: daysAfter(30),
      resolvedBy: null,
      version: before.version + 1,
    });
    expect(after!.contentSnapshot).toEqual(before.contentSnapshot);
  });

  it("removed messages aren't archived", async () => {
    await t.db
      .update(chatMessages)
      .set({ status: "removed" })
      .where(eq(chatMessages.body, "Great start"));
    await archiveThreadChat(t.db, memory.store, daysAfter(30), threadId);
    expect(fileLines().map((l) => l.body)).toEqual([
      "Lights out",
      "Safety car!",
    ]);
    expect(await rows()).toHaveLength(0);
  });

  it("a crash after the upload and before the delete is safe to run again", async () => {
    // The upload lands, then reading it back fails: the run dies there.
    const flaky: ChatArchiveStore = {
      put: memory.store.put,
      get: async () => {
        throw new Error("connection reset");
      },
    };
    await expect(
      archiveThreadChat(t.db, flaky, daysAfter(30), threadId),
    ).rejects.toThrow("connection reset");
    expect(memory.puts).toHaveLength(1);
    expect(await rows()).toHaveLength(3);
    expect(await t.db.select().from(chatArchives)).toHaveLength(0);

    expect(
      await archiveThreadChat(t.db, memory.store, daysAfter(30), threadId),
    ).toBe("archived");
    expect(fileLines()).toHaveLength(3);
    expect(await rows()).toHaveLength(0);
    expect(await t.db.select().from(chatArchives)).toHaveLength(1);
  });

  it("a file that comes back short leaves the rows in place", async () => {
    const short: ChatArchiveStore = {
      put: async () => {},
      get: async () => null,
    };
    await expect(
      archiveThreadChat(t.db, short, daysAfter(30), threadId),
    ).rejects.toThrow("holds -1 of 3");
    expect(await rows()).toHaveLength(3);
  });

  it("the export lists a message that was archived", async () => {
    await archiveThreadChat(t.db, memory.store, daysAfter(30), threadId);
    const data = await buildExport(t.db, fan.userId, {
      chatArchives: memory.store,
    });
    expect(data.chat).toEqual([
      expect.objectContaining({
        threadId,
        body: "Lights out",
        status: "archived",
      }),
      expect.objectContaining({ body: "Safety car!", status: "archived" }),
    ]);
  });

  it("the thread page replays the archive under the discussion", async () => {
    // Before the archive: the live rows.
    const before = await chatReplay(t.db, memory.store, threadId);
    expect(before?.messages.map((m) => `${m.author}: ${m.body}`)).toEqual([
      "fan: Lights out",
      "other: Great start",
      "fan: Safety car!",
    ]);
    await archiveThreadChat(t.db, memory.store, daysAfter(30), threadId);
    // After: the file, with today's names.
    const after = await chatReplay(t.db, memory.store, threadId);
    expect(after).toEqual({ ...before, unavailable: false });
    // A host that can't read the bucket says so, with the count.
    expect(await chatReplay(t.db, null, threadId)).toEqual({
      messages: [],
      total: 3,
      unavailable: true,
    });
    // So does one whose bucket read fails, rather than failing the page.
    const failing = {
      ...memory.store,
      get: async () => {
        throw new Error("bucket unreachable");
      },
    };
    expect(await chatReplay(t.db, failing, threadId)).toEqual({
      messages: [],
      total: 3,
      unavailable: true,
    });
    // Past the limit, the first ones and the count.
    const first = await chatReplay(t.db, memory.store, threadId, 2);
    expect(first?.messages).toHaveLength(2);
    expect(first?.total).toBe(3);
  });
});
