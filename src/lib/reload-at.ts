/** The longest delay a browser timer keeps (about 24.8 days). */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * How long until `at` on the page's clock: `serverNowMs` is the server's
 * time when the page loaded, at the browser's `loadedAtMs`. Null when
 * there's nothing to wait for, or it's too far ahead for one timer (the
 * page will have reloaded long before then).
 */
export function msUntil(
  at: string | null,
  serverNowMs: number,
  loadedAtMs: number,
  browserNowMs: number,
): number | null {
  if (at === null) return null;
  const ms = Date.parse(at) - serverNowMs - (browserNowMs - loadedAtMs);
  if (ms > MAX_TIMER_MS) return null;
  return Math.max(0, ms);
}
