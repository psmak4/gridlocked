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
function harness(startMs: number) {
  let nowMs = startMs;
  let heldServer: string | null = null;
  let refusing: string | null = null;
  let server: ChatMessageView[] = [];
  const requested: string[] = [];
  let pending: (() => void) | null = null;
  const channel = createRefreshChannel({
    windowSeconds: 3,
    timer: { now: () => nowMs, sleep: async () => {} },
    schedule: (fn) => {
      pending = fn;
      return () => {
        pending = null;
      };
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
      return new Response(
        JSON.stringify({
          messages: server,
          mode: "chat",
          now: heldServer ?? new Date(nowMs).toISOString(),
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
    refuseNext: (iso: string) => {
      refusing = iso;
    },
    serverNow: (iso: string) => {
      heldServer = iso;
    },
    setServer: (list: ChatMessageView[]) => {
      server = list;
    },
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

  it("follows the server's clock, even one that is held still", async () => {
    const h = harness(Date.parse("2026-06-07T13:10:00.500Z"));
    h.serverNow("2026-03-07T05:01:00.000Z");
    h.channel.subscribe("t1", () => {});
    await h.settle();
    await h.tick();
    expect(h.requested.at(-1)).toBe(
      "/api/chat/t1?after=2026-03-07T05:01:03.000Z",
    );
    await h.tick();
    // The held clock still says 05:01:00, so the next window is still :03.
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
});
