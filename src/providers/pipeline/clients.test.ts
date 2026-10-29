import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../../tests/helpers/test-db";
import { providerRequests, settings } from "@/db/schema";
import { fixedClock, simulatedClock, type Timer } from "@/lib/clock";
import { newId } from "@/lib/ids";
import { createPipelineClients, loadRecentCalls } from "./clients";

const NOW = new Date("2026-03-08T10:00:00.000Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe("pipeline clients", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.close();
  });

  const record = (provider: "jolpica" | "openf1", requestedAt: Date) =>
    t.db.insert(providerRequests).values({
      id: newId(),
      provider,
      endpoint: "/x",
      params: {},
      requestedAt,
      statusCode: 200,
      durationMs: 1,
      outcome: "unchanged",
    });

  function timer() {
    const clock = simulatedClock(NOW);
    const sleeps: number[] = [];
    const t: Timer = {
      now: () => clock.now().getTime(),
      sleep: async (ms) => {
        sleeps.push(ms);
        clock.advance(ms);
      },
    };
    return { clock, sleeps, timer: t };
  }

  describe("loadRecentCalls", () => {
    it("returns each provider's calls from the last hour, as epoch ms, oldest first", async () => {
      await record("jolpica", ago(5_000));
      await record("jolpica", ago(30 * 60_000));
      await record("openf1", ago(1_000));
      const { timer: tm } = timer();

      const calls = await loadRecentCalls(t.db, tm);

      expect(calls.jolpica).toEqual([
        ago(30 * 60_000).getTime(),
        ago(5_000).getTime(),
      ]);
      expect(calls.openf1).toEqual([ago(1_000).getTime()]);
    });

    it("leaves out calls older than an hour and calls stamped after now", async () => {
      await record("jolpica", ago(3_600_001));
      await record("jolpica", new Date(NOW.getTime() + 60_000));
      const { timer: tm } = timer();
      expect((await loadRecentCalls(t.db, tm)).jolpica).toEqual([]);
    });

    it("counts every attempt the log holds, whatever its outcome", async () => {
      for (const outcome of [
        "error",
        "rate_limited",
        "new_snapshot",
      ] as const) {
        await t.db.insert(providerRequests).values({
          id: newId(),
          provider: "openf1",
          endpoint: "/x",
          params: {},
          requestedAt: ago(1_000),
          statusCode: null,
          durationMs: 0,
          outcome,
        });
      }
      const { timer: tm } = timer();
      expect((await loadRecentCalls(t.db, tm)).openf1).toHaveLength(3);
    });
  });

  describe("createPipelineClients", () => {
    const okFetch = (async () =>
      new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    it("makes a new client wait as if the logged calls were its own (Jolpica 3/s)", async () => {
      // Three calls 100 ms ago fill Jolpica's 3/s window.
      for (let i = 0; i < 3; i++) await record("jolpica", ago(100));
      const { clock, sleeps, timer: tm } = timer();

      const { jolpica } = await createPipelineClients({
        db: t.db,
        clock,
        timer: tm,
        fetch: okFetch,
      });
      await jolpica.get("/2026.json");

      expect(sleeps).toEqual([900]);
    });

    it("keeps the providers apart and reads the limits from the provider_limits setting", async () => {
      // OpenF1 default is 2/s and 25/min. Lower it to 1/s; Jolpica stays at 3/s.
      await t.db.insert(settings).values({
        key: "provider_limits",
        value: {
          jolpica: { perSecond: 3, perHour: 400 },
          openf1: { perSecond: 1, perMinute: 25 },
        },
        updatedAt: NOW,
      });
      await record("openf1", ago(100));
      for (let i = 0; i < 2; i++) await record("jolpica", ago(100));
      const { clock, sleeps, timer: tm } = timer();

      const clients = await createPipelineClients({
        db: t.db,
        clock,
        timer: tm,
        fetch: okFetch,
      });
      await clients.jolpica.get("/a.json"); // 2 logged + 1 = 3 of 3: no wait
      expect(sleeps).toEqual([]);
      await clients.openf1.get("/sessions"); // 1 logged = 1 of 1: waits
      expect(sleeps).toEqual([900]);
    });

    it("with nothing logged, makes no wait", async () => {
      const { clock, sleeps, timer: tm } = timer();
      const clients = await createPipelineClients({
        db: t.db,
        clock,
        timer: tm,
        fetch: okFetch,
      });
      await clients.jolpica.get("/a.json");
      await clients.openf1.get("/sessions");
      expect(sleeps).toEqual([]);
    });

    it("stamps its own requests from the clock and logs them for the next invocation", async () => {
      const { sleeps, timer: tm } = timer();
      const clients = await createPipelineClients({
        db: t.db,
        clock: fixedClock(NOW),
        timer: tm,
        fetch: okFetch,
      });
      await clients.jolpica.get("/a.json");
      const rows = await t.db
        .select()
        .from(providerRequests)
        .where(eq(providerRequests.provider, "jolpica"));
      expect(rows.map((r) => r.requestedAt)).toEqual([NOW]);
      expect(sleeps).toEqual([]);
    });
  });
});
