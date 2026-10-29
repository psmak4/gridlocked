import { describe, expect, it } from "vitest";
import { simulatedClock, type Timer } from "@/lib/clock";
import { createRateLimiter } from "./rate-limiter";

const start = new Date("2026-03-01T00:00:00.000Z");

/** A timer on a simulated clock: sleeping advances it. */
function simulatedTimer(sleeps: number[] = []) {
  const clock = simulatedClock(start);
  const timer: Timer = {
    now: () => clock.now().getTime(),
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.advance(ms);
    },
  };
  return { clock, timer };
}

function setup(
  limits: Parameters<typeof createRateLimiter>[0],
  opts?: Parameters<typeof createRateLimiter>[2],
) {
  const sleeps: number[] = [];
  const { clock, timer } = simulatedTimer(sleeps);
  const limiter = createRateLimiter(limits, timer, opts);
  const elapsed = () => clock.now().getTime() - start.getTime();
  return { clock, limiter, sleeps, elapsed };
}

describe("createRateLimiter", () => {
  it("lets calls through without sleeping while under the limit", async () => {
    const { limiter, sleeps, elapsed } = setup({ perSecond: 3 });
    for (let i = 0; i < 3; i++) await limiter.acquire();
    expect(sleeps).toEqual([]);
    expect(elapsed()).toBe(0);
  });

  it("takes at least 3 simulated seconds for 10 calls at 3/s", async () => {
    const { limiter, elapsed } = setup({ perSecond: 3 });
    for (let i = 0; i < 10; i++) await limiter.acquire();
    expect(elapsed()).toBeGreaterThanOrEqual(3000);
  });

  it("never lets more than perSecond calls into any one-second window", async () => {
    const { limiter, clock } = setup({ perSecond: 3 });
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      await limiter.acquire();
      times.push(clock.now().getTime());
    }
    for (const [i, t] of times.entries()) {
      const inWindow = times.filter((u) => u >= t && u < t + 1000);
      expect(inWindow.length, `window at call ${i}`).toBeLessThanOrEqual(3);
    }
  });

  it("holds calls past perMinute until the minute rolls", async () => {
    const { limiter, elapsed } = setup({ perSecond: 100, perMinute: 25 });
    for (let i = 0; i < 25; i++) await limiter.acquire();
    expect(elapsed()).toBeLessThan(60_000);
    await limiter.acquire();
    expect(elapsed()).toBeGreaterThanOrEqual(60_000);
  });

  it("450 calls at perHour 400 leave 50 waiting until the hour rolls", async () => {
    const { limiter, clock } = setup({ perSecond: 3, perHour: 400 });
    const hour = 3_600_000;
    const times: number[] = [];
    for (let i = 0; i < 450; i++) {
      await limiter.acquire();
      times.push(clock.now().getTime() - start.getTime());
    }
    // The first 400 go through inside the first hour (400 / 3 per second).
    expect(times[399]!).toBeLessThan(hour);
    // The last 50 wait for the hour to roll.
    for (const t of times.slice(400)) expect(t).toBeGreaterThanOrEqual(hour);
    // No hour-long window ever holds more than 400 calls.
    for (const t of times) {
      const inWindow = times.filter((u) => u >= t && u < t + hour);
      expect(inWindow.length).toBeLessThanOrEqual(400);
    }
  });

  it("queues concurrent callers instead of letting them through together", async () => {
    // Concurrent sleepers wait in parallel, so a sleep moves the clock only up
    // to its own wake-up time instead of adding to the other sleepers' time.
    const clock = simulatedClock(start);
    const timer: Timer = {
      now: () => clock.now().getTime(),
      sleep: async (ms) => {
        const wakeAt = clock.now().getTime() + ms;
        if (clock.now().getTime() < wakeAt) clock.set(new Date(wakeAt));
      },
    };
    const limiter = createRateLimiter({ perSecond: 2 }, timer);
    await Promise.all(Array.from({ length: 6 }, () => limiter.acquire()));
    // 2 per second means the sixth call cannot be earlier than 2 s in, and
    // nothing forces it later than that.
    expect(clock.now().getTime() - start.getTime()).toBe(2000);
  });
  it("throws when its time has not moved after a sleep, instead of looping forever", async () => {
    const timer: Timer = { now: () => start.getTime(), sleep: async () => {} };
    const limiter = createRateLimiter({ perSecond: 1 }, timer);
    await limiter.acquire();
    await expect(limiter.acquire()).rejects.toThrow(
      "limiter clock is not advancing",
    );
  });

  describe("seeded with the calls other invocations already made", () => {
    const ago = (ms: number) => start.getTime() - ms;

    it("waits as if the seeded calls were its own, per second", async () => {
      // Three calls 100 ms ago fill the 3/s window until 900 ms from now.
      const { limiter, sleeps, elapsed } = setup(
        { perSecond: 3 },
        { seed: [ago(100), ago(100), ago(100)] },
      );
      await limiter.acquire();
      expect(sleeps).toEqual([900]);
      expect(elapsed()).toBe(900);
    });

    it("waits as if the seeded calls were its own, per minute", async () => {
      // 25 calls in the last 10 s: the 26th waits until the oldest is a minute old.
      const seed = Array.from({ length: 25 }, (_, i) => ago(10_000 - i * 100));
      const { limiter, elapsed } = setup(
        { perSecond: 100, perMinute: 25 },
        { seed },
      );
      await limiter.acquire();
      expect(elapsed()).toBe(50_000);
    });

    it("waits as if the seeded calls were its own, per hour", async () => {
      const seed = Array.from({ length: 400 }, (_, i) => ago(1_800_000 - i));
      const { limiter, elapsed } = setup(
        { perSecond: 3, perHour: 400 },
        { seed },
      );
      await limiter.acquire();
      // The oldest seeded call is 1_800_000 ms old: it leaves the hour in 1_800_000 ms.
      expect(elapsed()).toBe(3_600_000 - 1_800_000);
    });

    it("counts its own calls on top of the seeded ones", async () => {
      const { limiter, elapsed } = setup(
        { perSecond: 3 },
        { seed: [ago(100)] },
      );
      await limiter.acquire();
      await limiter.acquire();
      // One seeded call plus two of its own fill the window of three.
      expect(elapsed()).toBe(0);
      await limiter.acquire();
      // The seeded call is the first to leave the window.
      expect(elapsed()).toBe(900);
    });

    it("ignores seeded calls that are outside every window", async () => {
      const { limiter, sleeps } = setup(
        { perSecond: 1, perHour: 1 },
        { seed: [ago(3_600_001)] },
      );
      await limiter.acquire();
      expect(sleeps).toEqual([]);
    });

    it("accepts an unsorted seed", async () => {
      const { limiter, elapsed } = setup(
        { perSecond: 2 },
        { seed: [ago(100), ago(900)] },
      );
      await limiter.acquire();
      // The call 900 ms ago is the one that leaves first.
      expect(elapsed()).toBe(100);
    });
  });
});
