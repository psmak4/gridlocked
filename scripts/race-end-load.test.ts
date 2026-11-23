import { describe, expect, it } from "vitest";
import { requestPlan, runPlan, summarize } from "./race-end-load";

// M9 Task 12: the race-end load test. When a race ends, readers arrive at
// the scores page over a ramp, then each refreshes it every interval. The
// plan is pure; the run takes a fake clock and fetch here.

describe("the race-end load test", () => {
  it("the race-end plan opens the scores page for N readers within the ramp, then refreshes every interval, and reports HIT, MISS and status counts and latency percentiles", async () => {
    const plan = requestPlan({
      readers: 4,
      rampMs: 2_000,
      intervalMs: 10_000,
      durationMs: 30_000,
    });
    // Each reader's first request is inside the ramp, spread across it.
    const first = [0, 1, 2, 3].map((r) => plan.find((p) => p.reader === r)!.at);
    expect(first).toEqual([0, 500, 1_000, 1_500]);
    // Then one every interval until the end: 3 each (at 0, 10, 20 s).
    for (const r of [0, 1, 2, 3]) {
      const times = plan.filter((p) => p.reader === r).map((p) => p.at);
      expect(times).toEqual([first[r], first[r]! + 10_000, first[r]! + 20_000]);
    }
    expect(plan.map((p) => p.at)).toEqual(
      [...plan.map((p) => p.at)].sort((a, b) => a - b),
    );

    // The first request of each refresh round misses; the rest hit.
    let now = 0;
    const seen: string[] = [];
    const perRound = new Map<number, number>();
    const answers = await runPlan(plan, {
      url: new URL("https://staging.example.test/weekend"),
      clock: {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
      fetch: async (url) => {
        seen.push(String(url));
        const round = Math.floor(now / 10_000);
        const n = perRound.get(round) ?? 0;
        perRound.set(round, n + 1);
        return new Response("ok", {
          status: 200,
          headers: { "x-vercel-cache": n === 0 ? "MISS" : "HIT" },
        });
      },
    });
    expect(seen).toHaveLength(12);
    expect(new Set(seen)).toEqual(
      new Set(["https://staging.example.test/weekend"]),
    );

    const report = summarize(answers);
    expect(report.requests).toBe(12);
    expect(report.status).toEqual({ 200: 12 });
    expect(report.cache).toEqual({ MISS: 3, HIT: 9 });
    // Timed on the clock: the virtual one here moves with the loop's
    // sleeps, so the percentiles themselves are tested on their own below.
    expect(report.latency).toEqual({
      p50: expect.any(Number),
      p95: expect.any(Number),
      max: expect.any(Number),
    });
  });

  it("reports latency percentiles from the answers", () => {
    const answers = Array.from({ length: 100 }, (_, i) => ({
      at: 0,
      status: 200,
      cache: "HIT",
      ms: i + 1,
    }));
    expect(summarize(answers).latency).toEqual({ p50: 51, p95: 96, max: 100 });
  });

  it("counts a failed request as status 0 and cache error", () => {
    expect(
      summarize([
        { at: 0, status: 0, cache: "error", ms: 5 },
        { at: 0, status: 503, cache: "MISS", ms: 40 },
      ]),
    ).toMatchObject({
      requests: 2,
      status: { 0: 1, 503: 1 },
      cache: { error: 1, MISS: 1 },
    });
  });
});
