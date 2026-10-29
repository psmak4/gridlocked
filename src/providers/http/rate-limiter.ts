import type { Timer } from "@/lib/clock";

export interface RateLimits {
  perSecond: number;
  perMinute?: number;
  perHour?: number;
}

export interface RateLimiter {
  /**
   * Resolves when the caller may make one request, and counts it. Returns the
   * timer's now (epoch ms) at which the call was recorded, for the request log.
   *
   * With a `deadline` (the timer's epoch ms), a wait that would end after it
   * throws `LimiterDeadlineError` straight away instead of sleeping, and
   * records nothing.
   */
  acquire(deadline?: number): Promise<number>;
}

/** A limiter that can be topped up from the request log between wakes. */
export interface SeedableRateLimiter extends RateLimiter {
  /**
   * Merges calls read from `provider_requests` (epoch ms, any order) into what
   * the limiter holds. Per millisecond the count is the larger of the two, so
   * a call that is both in memory and in the log counts once, a call that was
   * sent but not yet logged is kept, and a call only the log knows is added.
   */
  seed(times: readonly number[]): void;
}

/** The wait for a rate-limit slot would run past the caller's deadline. */
export class LimiterDeadlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LimiterDeadlineError";
  }
}

/** Sleeps in a row that may leave the timer's reading unchanged. */
const MAX_STALLED_SLEEPS = 3;

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

export interface RateLimiterOptions {
  /**
   * Epoch milliseconds of calls already made (by earlier or overlapping
   * invocations, read from `provider_requests`), in any order. They count
   * against the windows exactly as the limiter's own calls do.
   */
  seed?: readonly number[];
}

/**
 * A sliding window over the recorded call times. A call is allowed when, for
 * every configured window, fewer than `limit` calls were recorded inside it.
 * Otherwise `acquire()` sleeps until the oldest blocking call leaves the
 * window, then checks again. Time and waiting both come from the `Timer`
 * (real time in production, a simulated one in tests, so they run instantly).
 * A timer that stays put through three sleeps in a row would loop forever, so
 * that throws `limiter clock is not advancing` (one sleep can return with
 * `Date.now()` unchanged, so a single stall is not an error).
 *
 * The check and the record happen with no `await` between them, so concurrent
 * callers cannot both claim the last slot: the loser re-checks after its sleep.
 */
export function createRateLimiter(
  limits: RateLimits,
  timer: Timer,
  opts: RateLimiterOptions = {},
): SeedableRateLimiter {
  const windows: Array<{ ms: number; limit: number }> = [
    { ms: SECOND, limit: limits.perSecond },
  ];
  if (limits.perMinute !== undefined) {
    windows.push({ ms: MINUTE, limit: limits.perMinute });
  }
  if (limits.perHour !== undefined) {
    windows.push({ ms: HOUR, limit: limits.perHour });
  }
  const longest = Math.max(...windows.map((w) => w.ms));

  // Call times in ms, oldest first (the timer never runs backwards).
  const calls: number[] = [];

  /** Milliseconds until a call would be allowed; 0 when it is allowed now. */
  function waitMs(now: number): number {
    let wait = 0;
    for (const { ms, limit } of windows) {
      // Calls strictly newer than `now - ms` still count against the window.
      const inWindow = calls.filter((t) => t > now - ms);
      if (inWindow.length >= limit) {
        // The call that must leave the window to free a slot.
        const blocker = inWindow[inWindow.length - limit]!;
        wait = Math.max(wait, blocker + ms - now);
      }
    }
    return wait;
  }

  function seed(times: readonly number[]): void {
    const counts = new Map<number, number>();
    for (const t of calls) counts.set(t, (counts.get(t) ?? 0) + 1);
    const incoming = new Map<number, number>();
    for (const t of times) incoming.set(t, (incoming.get(t) ?? 0) + 1);
    for (const [t, n] of incoming)
      counts.set(t, Math.max(counts.get(t) ?? 0, n));
    calls.length = 0;
    for (const t of [...counts.keys()].sort((a, b) => a - b)) {
      for (let i = 0; i < counts.get(t)!; i++) calls.push(t);
    }
  }
  seed(opts.seed ?? []);

  return {
    seed,
    async acquire(deadline) {
      let stalled = 0;
      for (;;) {
        const now = timer.now();
        while (calls.length > 0 && calls[0]! <= now - longest) calls.shift();
        const wait = waitMs(now);
        if (wait <= 0) {
          calls.push(now);
          return now;
        }
        if (deadline !== undefined && now + wait > deadline) {
          throw new LimiterDeadlineError(
            `a rate-limit wait of ${wait} ms would end after the deadline`,
          );
        }
        await timer.sleep(wait);
        if (timer.now() <= now) {
          if (++stalled >= MAX_STALLED_SLEEPS) {
            throw new Error("limiter clock is not advancing");
          }
        } else {
          stalled = 0;
        }
      }
    },
  };
}
