import { describe, expect, it } from "vitest";
import { simulatedClock } from "@/lib/clock";
import { createRateLimiter } from "./rate-limiter";

const start = new Date("2026-03-01T00:00:00.000Z");

function setup(limits: Parameters<typeof createRateLimiter>[0]) {
  const clock = simulatedClock(start);
  const sleeps: number[] = [];
  const sleep = async (ms: number) => {
    sleeps.push(ms);
    clock.advance(ms);
  };
  const limiter = createRateLimiter(limits, clock, sleep);
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
    const sleep = async (ms: number) => {
      const wakeAt = clock.now().getTime() + ms;
      if (clock.now().getTime() < wakeAt) clock.set(new Date(wakeAt));
    };
    const limiter = createRateLimiter({ perSecond: 2 }, clock, sleep);
    await Promise.all(Array.from({ length: 6 }, () => limiter.acquire()));
    // 2 per second means the sixth call cannot be earlier than 2 s in, and
    // nothing forces it later than that.
    expect(clock.now().getTime() - start.getTime()).toBe(2000);
  });
});
