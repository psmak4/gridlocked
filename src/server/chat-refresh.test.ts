import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import { seedViewer } from "../../tests/helpers/community";
import { seedEventSessions } from "../../tests/helpers/sessions";
import { sessions, threads } from "@/db/schema";
import { sendChat } from "@/community/chat";
import { openSessionThreads } from "@/community/session-threads";
import { chatRefreshResponse, type RunWithNow } from "./chat-refresh";
import type { ServerDb } from "./db";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

const RACE = new Date("2026-06-07T13:00:00Z");
const LIVE = new Date("2026-06-07T13:10:00Z");

describe("the chat refresh route (HLD §11.2)", () => {
  let t: TestDb;
  let threadId: string;
  let run: RunWithNow;

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
    const fan = await seedViewer(t.db, { trustLevel: 2, username: "fan" });
    await sendChat(t.db, LIVE, fan, { threadId, body: "Lights out" });
    run = (fn) => fn(t.db as unknown as ServerDb, LIVE);
  });

  afterEach(async () => {
    await t.close();
  });

  const get = (after: string, init?: RequestInit) =>
    chatRefreshResponse(
      new Request(`http://localhost/api/chat/${threadId}?after=${after}`, init),
      threadId,
      run,
    );

  it("the refresh response has no Vary header and is public, s-maxage=3", async () => {
    const response = await get(LIVE.toISOString());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("public, s-maxage=3");
    expect(response.headers.get("Vary")).toBeNull();
    expect(response.headers.get("Set-Cookie")).toBeNull();
    const body = (await response.json()) as {
      messages: { body: string; author: string }[];
      mode: string;
      windowStart: string;
    };
    expect(body.mode).toBe("chat");
    // The window it answers, so a client can tell its own from another's.
    expect(body.windowStart).toBe(LIVE.toISOString());
    expect(body.messages).toMatchObject([
      { body: "Lights out", author: "fan" },
    ]);
  });

  it("the refresh route never reads the session cookie", async () => {
    const plain = await get(LIVE.toISOString());
    const withCookie = await get(LIVE.toISOString(), {
      headers: { cookie: "better-auth.session_token=abc.def" },
    });
    expect(await withCookie.text()).toBe(await plain.text());
  });

  it("only a window's start, and not one far ahead, is a URL it answers", async () => {
    const misaligned = new Date(LIVE.getTime() + 1000).toISOString();
    expect((await get(misaligned)).status).toBe(400);
    const ahead = await get(new Date(LIVE.getTime() + 60_000).toISOString());
    expect(ahead.status).toBe(400);
    expect(ahead.headers.get("Cache-Control")).toBe("private, no-store");
    // It says the server's time, so the client can line up again.
    expect(await ahead.json()).toEqual({
      error: "bad_window",
      now: LIVE.toISOString(),
    });
    const bad = await get("yesterday");
    expect(bad.status).toBe(400);
    expect(bad.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("each window has one address, so nobody can make the cache miss", async () => {
    const start = LIVE.toISOString();
    expect((await get(start)).status).toBe(200);
    // Another spelling of the same instant.
    expect((await get(start.replace(".000Z", "Z"))).status).toBe(400);
    // Anything else in the query.
    expect((await get(`${start}&x=1`)).status).toBe(400);
    // A window long past: nobody's page asks for one.
    expect(
      (await get(new Date(LIVE.getTime() - 120_000).toISOString())).status,
    ).toBe(400);
  });

  it("a window before the first message is empty, and a user thread is not found", async () => {
    const early = new Date(LIVE.getTime() - 60_000).toISOString();
    const body = (await (await get(early)).json()) as { messages: unknown[] };
    expect(body.messages).toEqual([]);
    expect(
      (
        await chatRefreshResponse(
          new Request(`http://localhost/api/chat/x?after=${early}`),
          "not-a-uuid",
          run,
        )
      ).status,
    ).toBe(404);
  });
});
