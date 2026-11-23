import { describe, expect, it } from "vitest";
import type { ChatMessageView } from "./channel";
import { mergeRefresh, refreshUrl, windowStart } from "./channel";
import { createRefreshChannel } from "./refresh";

const msg = (id: string, body = id): ChatMessageView => ({
  id,
  author: "fan",
  body,
  createdAt: "2026-06-07T13:10:00.000Z",
});

/** A fake server, clock and scheduler the test steps by hand. */
function harness(
  startMs: number,
  options: { random?: () => number; limit?: number } = {},
) {
  let nowMs = startMs;
  let heldServer: string | null = null;
  let refusing: string | null = null;
  let staleMs = 0;
  let server: ChatMessageView[] = [];
  const requested: string[] = [];
  const waits: number[] = [];
  const sinceAsked: (string | null)[] = [];
  let pending: (() => void) | null = null;
  const channel = createRefreshChannel({
    windowSeconds: 3,
    timer: { now: () => nowMs, sleep: async () => {} },
    random: options.random ?? (() => 0),
    schedule: (fn, ms) => {
      pending = fn;
      waits.push(ms);
      return () => {
        pending = null;
      };
    },
    since: async (_threadId, afterId) => {
      sinceAsked.push(afterId);
      const from = server.findIndex((m) => m.id > afterId);
      return from < 0 ? [] : server.slice(from, from + 50);
    },
    fetch: (async (url: string) => {
      requested.push(url);
      if (refusing) {
        const now = refusing;
        refusing = null;
        return new Response(JSON.stringify({ error: "bad_window", now }), {
          status: 400,
        });
      }
      // Like the server: the latest `limit` messages, and a cached copy
      // carries the time it was made.
      const now = heldServer ?? new Date(nowMs - staleMs).toISOString();
      staleMs = 0;
      return new Response(
        JSON.stringify({
          messages: server.slice(-(options.limit ?? 50)),
          mode: "chat",
          now,
        }),
      );
    }) as typeof fetch,
    send: async (_threadId, body) => {
      const message = msg(`m${server.length + 1}`, body);
      server = [...server, message];
      return { ok: true, message };
    },
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    channel,
    requested,
    waits,
    sinceAsked,
    /** The next answer is a cached copy made `ms` ago. */
    staleNext: (ms: number) => {
      staleMs = ms;
    },
    refuseNext: (iso: string) => {
      refusing = iso;
    },
    serverNow: (iso: string) => {
      heldServer = iso;
    },
    setServer: (list: ChatMessageView[]) => {
      server = list;
    },
    /** Runs the waiting refresh, `ms` later. */
    async tick(ms = 3000) {
      nowMs += ms;
      const fn = pending;
      pending = null;
      fn?.();
      await settle();
    },
    settle,
  };
}

describe("the refresh channel", () => {
  it("asks every client for the same URL in a window", () => {
    const at = Date.parse("2026-06-07T13:10:01.700Z");
    expect(windowStart(at, 3)).toBe(Date.parse("2026-06-07T13:10:00.000Z"));
    expect(refreshUrl("t1", windowStart(at, 3))).toBe(
      "/api/chat/t1?after=2026-06-07T13:10:00.000Z",
    );
  });

  it("a message sent between two refreshes appears exactly once", async () => {
    const h = harness(Date.parse("2026-06-07T13:10:00.500Z"));
    h.setServer([msg("m1")]);
    const seen: string[][] = [];
    h.channel.subscribe("t1", (list) => seen.push(list.map((m) => m.id)));
    await h.settle();
    expect(seen.at(-1)).toEqual(["m1"]);

    const sent = await h.channel.send("t1", "Box box");
    expect(sent.ok).toBe(true);
    expect(seen.at(-1)).toEqual(["m1", "m2"]);

    await h.tick();
    expect(seen.at(-1)).toEqual(["m1", "m2"]);
    expect(h.requested).toEqual([
      "/api/chat/t1?after=2026-06-07T13:10:00.000Z",
      "/api/chat/t1?after=2026-06-07T13:10:03.000Z",
    ]);
  });

  it("a message removed on the server leaves the screen on the next refresh", () => {
    const shown = [msg("m1"), msg("m2"), msg("m3")];
    expect(
      mergeRefresh(shown, [msg("m1"), msg("m3")]).map((m) => m.id),
    ).toEqual(["m1", "m3"]);
    // Older than the refresh reaches: kept. Newer (sent here since): kept.
    expect(
      mergeRefresh([msg("a"), msg("m2"), msg("z")], [msg("m1"), msg("m3")]).map(
        (m) => m.id,
      ),
    ).toEqual(["a", "m1", "m3", "z"]);
  });

  it("follows a held server clock through its refusals", async () => {
    const h = harness(Date.parse("2026-06-07T13:10:00.500Z"));
    h.serverNow("2026-03-07T05:01:00.000Z");
    h.channel.subscribe("t1", () => {});
    await h.settle();
    await h.tick();
    expect(h.requested.at(-1)).toBe(
      "/api/chat/t1?after=2026-03-07T05:01:03.000Z",
    );
    // An answer's time may be a cached copy's, so it doesn't move the clock.
    await h.tick();
    expect(h.requested.at(-1)).toBe(
      "/api/chat/t1?after=2026-03-07T05:01:06.000Z",
    );
    // Run too far ahead of the held clock, the server refuses, with its time.
    h.refuseNext("2026-03-07T05:01:00.000Z");
    await h.tick();
    await h.tick();
    expect(h.requested.at(-1)).toBe(
      "/api/chat/t1?after=2026-03-07T05:01:03.000Z",
    );
  });

  it("a refused window still lines the client up with the server", async () => {
    const h = harness(Date.parse("2026-06-07T13:10:00.500Z"));
    h.refuseNext("2026-03-07T05:01:00.000Z");
    h.channel.subscribe("t1", () => {});
    await h.settle();
    await h.tick();
    expect(h.requested.at(-1)).toBe(
      "/api/chat/t1?after=2026-03-07T05:01:03.000Z",
    );
  });

  it("an empty chat is told to the screen, once", async () => {
    const h = harness(Date.parse("2026-06-07T13:10:00.500Z"));
    const seen: number[] = [];
    h.channel.subscribe("t1", (list) => seen.push(list.length));
    await h.settle();
    expect(seen).toEqual([0]);
    await h.tick();
    expect(seen).toEqual([0]);
  });

  it("stops asking once unsubscribed", async () => {
    const h = harness(Date.parse("2026-06-07T13:10:00.500Z"));
    const stop = h.channel.subscribe("t1", () => {});
    await h.settle();
    stop();
    await h.tick();
    expect(h.requested).toHaveLength(1);
  });

  it("a client settles its window from its own clock offset, not the cached answer's time", async () => {
    const h = harness(Date.parse("2026-06-07T13:10:00.500Z"));
    h.channel.subscribe("t1", () => {});
    await h.settle();
    expect(h.requested.at(-1)).toBe(
      "/api/chat/t1?after=2026-06-07T13:10:00.000Z",
    );
    // A cached copy of the window, made 2.5 seconds before this read.
    h.staleNext(2500);
    await h.tick();
    expect(h.requested.at(-1)).toBe(
      "/api/chat/t1?after=2026-06-07T13:10:03.000Z",
    );
    await h.tick();
    expect(h.requested.at(-1)).toBe(
      "/api/chat/t1?after=2026-06-07T13:10:06.000Z",
    );
  });

  it("a client that missed more than 50 messages, or slept, fills the gap with chatSince before it shows new ones", async () => {
    const h = harness(Date.parse("2026-06-07T13:10:00.500Z"));
    const id = (n: number) => `m${String(n).padStart(3, "0")}`;
    h.setServer([1, 2, 3].map((n) => msg(id(n))));
    const seen: string[][] = [];
    h.channel.subscribe("t1", (list) => seen.push(list.map((m) => m.id)));
    await h.settle();
    expect(seen).toEqual([[id(1), id(2), id(3)]]);

    // The phone slept through 120 messages; the refresh carries the last 50.
    h.setServer(Array.from({ length: 123 }, (_, i) => msg(id(i + 1))));
    await h.tick(60_000);
    expect(h.sinceAsked).toEqual([id(3), id(53)]);
    // One update, with nothing skipped.
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual(Array.from({ length: 123 }, (_, i) => id(i + 1)));
  });

  it("clients start their first refresh at a random point in the window", async () => {
    const h = harness(Date.parse("2026-06-07T13:10:00.500Z"), {
      random: () => 0.5,
    });
    h.channel.subscribe("t1", () => {});
    await h.settle();
    // Half a window from now, and every refresh after at the same point.
    expect(h.requested).toEqual([]);
    expect(h.waits).toEqual([1500]);
    await h.tick(1500);
    expect(h.requested).toEqual([
      "/api/chat/t1?after=2026-06-07T13:10:00.000Z",
    ]);
    expect(h.waits.at(-1)).toBe(3000);
  });
});
