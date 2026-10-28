import type { Clock } from "@/lib/clock";

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

/**
 * A sliding window over the recorded call times. A call is allowed when, for
 * every configured window, fewer than `limit` calls were recorded inside it.
 * Otherwise `acquire()` sleeps until the oldest blocking call leaves the
 * window, then checks again. Time comes from the clock and waiting from the
 * injected `sleep`, so tests run instantly.
 *
 * The check and the record happen with no `await` between them, so concurrent
 * callers cannot both claim the last slot: the loser re-checks after its sleep.
 */
export function createRateLimiter(
  limits: RateLimits,
  clock: Clock,
  sleep: (ms: number) => Promise<void>,
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

  // Call times in ms, oldest first (the clock never runs backwards).
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

  return {
    async acquire() {
      for (;;) {
        const now = clock.now().getTime();
        while (calls.length > 0 && calls[0]! <= now - longest) calls.shift();
        const wait = waitMs(now);
        if (wait <= 0) {
          calls.push(now);
          return;
        }
        await sleep(wait);
      }
    },
  };
}
