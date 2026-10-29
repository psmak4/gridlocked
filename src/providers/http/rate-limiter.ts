import type { Timer } from "@/lib/clock";

export interface RateLimits {
  perSecond: number;
  perMinute?: number;
  perHour?: number;
}

export interface RateLimiter {
  /** Resolves when the caller may make one request, and counts it. */
  acquire(): Promise<void>;
}

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
 * A timer whose time has not moved after a sleep would loop forever, so that
 * throws `limiter clock is not advancing`.
 *
 * The check and the record happen with no `await` between them, so concurrent
 * callers cannot both claim the last slot: the loser re-checks after its sleep.
 */
export function createRateLimiter(
  limits: RateLimits,
  timer: Timer,
  opts: RateLimiterOptions = {},
): RateLimiter {
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
  const calls: number[] = [...(opts.seed ?? [])].sort((a, b) => a - b);

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

  return {
    async acquire() {
      for (;;) {
        const now = timer.now();
        while (calls.length > 0 && calls[0]! <= now - longest) calls.shift();
        const wait = waitMs(now);
        if (wait <= 0) {
          calls.push(now);
          return;
        }
        await timer.sleep(wait);
        if (timer.now() <= now) {
          throw new Error("limiter clock is not advancing");
        }
      }
    },
  };
}
