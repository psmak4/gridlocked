import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../../tests/helpers/test-db";
import { providerRequests, settings } from "@/db/schema";
import { fixedClock, simulatedClock, type Timer } from "@/lib/clock";
import { newId } from "@/lib/ids";
import { ProviderUnavailableError } from "@/jobs/ports";
import {
  createPipelineClients,
  createSharedLimiters,
  loadRecentCalls,
} from "./clients";

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

    it("stamps its own requests from the timer, not the tick's frozen clock, and logs them for the next invocation", async () => {
      // The tick's clock is frozen at its scheduled minute; real time is 20 s on.
      const real = simulatedClock(new Date(NOW.getTime() + 20_000));
      const tm: Timer = {
        now: () => real.now().getTime(),
        sleep: async (ms) => real.advance(ms),
      };
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
      expect(rows.map((r) => r.requestedAt)).toEqual([
        new Date(NOW.getTime() + 20_000),
      ]);
    });

    it("passes the wake's deadline to the clients: a wait past it fails fast as ProviderUnavailableError", async () => {
      for (let i = 0; i < 3; i++) await record("jolpica", ago(100));
      const { clock, sleeps, timer: tm } = timer();
      const { jolpica } = await createPipelineClients({
        db: t.db,
        clock,
        timer: tm,
        fetch: okFetch,
        deadlineAt: NOW.getTime() + 500, // the 3/s window frees up at +900
      });
      await expect(jolpica.get("/2026.json")).rejects.toBeInstanceOf(
        ProviderUnavailableError,
      );
      expect(sleeps).toEqual([]);
    });

    describe("OpenF1's 25 a minute across two ticks (the log carries real time)", () => {
      it("never lets more than 25 calls into any rolling 60 s, though each tick's clock is frozen", async () => {
        const T = NOW.getTime();
        const real = simulatedClock(NOW);
        const tm: Timer = {
          now: () => real.now().getTime(),
          sleep: async (ms) => real.advance(ms),
        };
        const sentAt: number[] = [];
        const trackedFetch = (async () => {
          sentAt.push(real.now().getTime());
          real.advance(10);
          return new Response("[]", {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }) as typeof fetch;

        // Tick 1 (minute T) starts late in its minute: 18 calls from T+50 s.
        real.set(new Date(T + 50_000));
        const tick1 = await createPipelineClients({
          db: t.db,
          clock: fixedClock(NOW),
          timer: tm,
          fetch: trackedFetch,
        });
        for (let i = 0; i < 18; i++) {
          await tick1.openf1.get("/sessions", { n: String(i) });
        }

        // Tick 2 (minute T + 60 s) wakes while tick 1 is still going, with a
        // new limiter seeded from the log, and sends 20 more.
        real.set(new Date(Math.max(T + 60_000, real.now().getTime() - 5_000)));
        const tick2 = await createPipelineClients({
          db: t.db,
          clock: fixedClock(new Date(T + 60_000)),
          timer: tm,
          fetch: trackedFetch,
        });
        for (let i = 0; i < 20; i++) {
          await tick2.openf1.get("/sessions", { n: String(100 + i) });
        }

        expect(sentAt).toHaveLength(38);
        for (const start of sentAt) {
          const inWindow = sentAt.filter(
            (s) => s >= start && s < start + 60_000,
          );
          expect(inWindow.length).toBeLessThanOrEqual(25);
        }
        // Tick 2 had to wait for tick 1's calls to leave the window.
        expect(sentAt[sentAt.length - 1]! - sentAt[18]!).toBeGreaterThan(0);
      });
    });
  });

  describe("createSharedLimiters (one per isolate, re-seeded at each wake)", () => {
    it("hands every wake the same limiter objects, so overlapping wakes share them", async () => {
      const { timer: tm } = timer();
      const shared = createSharedLimiters(tm);
      const first = await shared.prepare(t.db);
      const second = await shared.prepare(t.db);
      expect(second.jolpica).toBe(first.jolpica);
      expect(second.openf1).toBe(first.openf1);
    });

    it("counts calls an earlier wake sent but has not logged yet", async () => {
      const { sleeps, timer: tm } = timer();
      const shared = createSharedLimiters(tm);
      const wakeA = await shared.prepare(t.db);
      for (let i = 0; i < 3; i++) await wakeA.jolpica.acquire(); // 3/s, nothing logged
      // A second wake in the same isolate re-seeds from the (empty) log.
      const wakeB = await shared.prepare(t.db);
      await wakeB.jolpica.acquire();
      expect(sleeps).toEqual([1000]);
    });

    it("does not count a call twice when it is both in memory and in the log", async () => {
      const { sleeps, timer: tm } = timer();
      const shared = createSharedLimiters(tm);
      const wakeA = await shared.prepare(t.db);
      await wakeA.jolpica.acquire();
      await wakeA.jolpica.acquire();
      // Both calls were logged, at the instants the limiter recorded them.
      await record("jolpica", NOW);
      await record("jolpica", NOW);
      const wakeB = await shared.prepare(t.db);
      await wakeB.jolpica.acquire(); // 3rd of 3/s: still room
      expect(sleeps).toEqual([]);
    });

    it("picks up calls only the log knows (another isolate's)", async () => {
      const { sleeps, timer: tm } = timer();
      const shared = createSharedLimiters(tm);
      await shared.prepare(t.db);
      for (let i = 0; i < 3; i++) await record("jolpica", ago(100));
      const wake = await shared.prepare(t.db);
      await wake.jolpica.acquire();
      expect(sleeps).toEqual([900]);
    });

    it("uses a changed provider_limits setting at the next wake", async () => {
      const { sleeps, timer: tm } = timer();
      const shared = createSharedLimiters(tm);
      await (await shared.prepare(t.db)).openf1.acquire();
      await t.db.insert(settings).values({
        key: "provider_limits",
        value: {
          jolpica: { perSecond: 3, perHour: 400 },
          openf1: { perSecond: 1, perMinute: 25 },
        },
        updatedAt: NOW,
      });
      await record("openf1", NOW);
      const wake = await shared.prepare(t.db);
      await wake.openf1.acquire(); // now 1/s with one call this second
      expect(sleeps).toEqual([1000]);
    });
  });
});
