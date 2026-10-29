import { describe, expect, it } from "vitest";
import { simulatedClock, type Timer } from "@/lib/clock";
import { createRateLimiter, LimiterDeadlineError } from "./rate-limiter";

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
  it("returns the time it recorded the call at, so the caller can stamp the request log with it", async () => {
    const { limiter, clock } = setup({ perSecond: 1 });
    expect(await limiter.acquire()).toBe(start.getTime());
    // The second call waits a second; it is recorded at the end of the wait.
    expect(await limiter.acquire()).toBe(start.getTime() + 1000);
    expect(clock.now().getTime()).toBe(start.getTime() + 1000);
  });

  describe("a clock that does not advance", () => {
    it("throws after three sleeps in a row that moved nothing, instead of looping forever", async () => {
      let sleeps = 0;
      const timer: Timer = {
        now: () => start.getTime(),
        sleep: async () => void sleeps++,
      };
      const limiter = createRateLimiter({ perSecond: 1 }, timer);
      await limiter.acquire();
      await expect(limiter.acquire()).rejects.toThrow(
        "limiter clock is not advancing",
      );
      expect(sleeps).toBe(3);
    });

    it("tolerates a sleep that returns with the millisecond unchanged, then moves on", async () => {
      // Date.now() can read the same value after a 1 ms timer. The second
      // sleep gets the time moving, and the call goes through.
      let time = start.getTime();
      let sleeps = 0;
      const timer: Timer = {
        now: () => time,
        sleep: async (ms) => {
          sleeps++;
          if (sleeps >= 2) time += ms;
        },
      };
      const limiter = createRateLimiter({ perSecond: 1 }, timer);
      await limiter.acquire();
      await expect(limiter.acquire()).resolves.toBeGreaterThan(start.getTime());
      expect(sleeps).toBe(2);
    });
  });

  describe("with a deadline", () => {
    it("fails fast, without sleeping, when the wait would end after the deadline", async () => {
      const { limiter, sleeps, elapsed } = setup({ perSecond: 1 });
      await limiter.acquire();
      // The next slot is 1000 ms away; the budget is 500 ms.
      await expect(
        limiter.acquire(start.getTime() + 500),
      ).rejects.toBeInstanceOf(LimiterDeadlineError);
      expect(sleeps).toEqual([]);
      expect(elapsed()).toBe(0);
    });

    it("waits when the wait ends exactly at the deadline, and records nothing for a failed call", async () => {
      const { limiter, sleeps } = setup({ perSecond: 1 });
      await limiter.acquire();
      await expect(
        limiter.acquire(start.getTime() + 999),
      ).rejects.toBeInstanceOf(LimiterDeadlineError);
      // The failed attempt took no slot: the wait is still one second.
      await limiter.acquire(start.getTime() + 1000);
      expect(sleeps).toEqual([1000]);
    });

    it("lets a call through with no wait even when the deadline is near", async () => {
      const { limiter } = setup({ perSecond: 3 });
      await expect(limiter.acquire(start.getTime() + 1)).resolves.toBe(
        start.getTime(),
      );
    });
  });

  describe("seed() merges the log into what the limiter already holds", () => {
    const ago = (ms: number) => start.getTime() - ms;

    it("counts a call that is both in memory and in the log once", async () => {
      const { limiter, sleeps } = setup({ perSecond: 2 });
      await limiter.acquire(); // recorded at `start`
      // The log has that same call (and nothing else).
      limiter.seed([start.getTime()]);
      await limiter.acquire(); // 2nd of 2: no wait
      expect(sleeps).toEqual([]);
      await limiter.acquire(); // 3rd: waits for the window
      expect(sleeps).toEqual([1000]);
    });

    it("keeps calls that are only in memory (sent, not yet logged) and adds calls only in the log", async () => {
      const { limiter, sleeps } = setup({ perSecond: 3 });
      await limiter.acquire(); // memory only
      limiter.seed([ago(100), ago(100)]); // log only
      // 1 + 2 = 3 of 3 in the window.
      await limiter.acquire();
      expect(sleeps).toEqual([900]);
    });

    it("never lowers a count: two calls in the same millisecond stay two", async () => {
      const { limiter, sleeps } = setup({ perSecond: 2 });
      await limiter.acquire();
      await limiter.acquire();
      limiter.seed([start.getTime()]);
      await limiter.acquire();
      expect(sleeps).toEqual([1000]);
    });
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
