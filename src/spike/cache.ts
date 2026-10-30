/**
 * Spike: the Cache-Control values the probe checks on every host (plan
 * Task 3). A shared cache may store the first two; never the third.
 */
const CACHE_CONTROL = {
  "public-page": "public, s-maxage=60, stale-while-revalidate=300",
  "chat-window": "public, s-maxage=3",
  private: "private, no-store",
} as const;

export type CacheKind = keyof typeof CACHE_CONTROL;

export function cacheControl(kind: CacheKind): string {
  return CACHE_CONTROL[kind];
}

/** The chat refresh window everyone shares: epoch seconds / 3, rounded down. */
export function chatWindow(epochMs: number): number {
  return Math.floor(epochMs / 3_000);
}
