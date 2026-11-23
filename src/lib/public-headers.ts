/**
 * For a public data page a logged-out visitor sees (M6 decision 3): the same
 * for everyone, so a CDN keeps it for a minute and serves a stale copy for
 * thirty seconds while it fetches a new one (M9 Task 6). It never sets a
 * cookie or varies by viewer.
 *
 * Vercel's CDN won't cache a response with `Vary: Cookie`, so a signed-in
 * reader is kept out of the shared copy at the edge instead: a request that
 * carries the session cookie gets `__signed_in=1` added to its query
 * (`signedInRoutes`, wired in `vite.config.ts`), which puts it under another
 * cache key, and its answer is `private, no-store`, so nothing is kept.
 */
export const PUBLIC_CACHE = "public, s-maxage=60, stale-while-revalidate=30";

/** Within 30 minutes of a lock, a stale copy lives 10 seconds at most. */
const NEAR_LOCK_CACHE = "public, s-maxage=60, stale-while-revalidate=10";

const NEAR_LOCK_MS = 30 * 60_000;

/** Better Auth's session cookie, with `useSecureCookies` on. */
export const SESSION_COOKIE = "__Secure-better-auth.session_token";

/** The query flag the edge adds to a request with a session cookie. */
export const SIGNED_IN_FLAG = "__signed_in";

/** The public header for a page, given the next lock (null: none ahead). */
export function publicCache(now: Date, nextLockAt: Date | null): string {
  if (!nextLockAt) return PUBLIC_CACHE;
  const ahead = nextLockAt.getTime() - now.getTime();
  return ahead >= 0 && ahead <= NEAR_LOCK_MS ? NEAR_LOCK_CACHE : PUBLIC_CACHE;
}

/** The weekend hub's header, from its page: the weekend's own lock. */
export function weekendCache(page: {
  now: string;
  weekend: { lockAt: string } | null;
}): string {
  return publicCache(
    new Date(page.now),
    page.weekend ? new Date(page.weekend.lockAt) : null,
  );
}

export const publicHeaders = (cacheControl: string = PUBLIC_CACHE) => ({
  "Cache-Control": cacheControl,
});

/**
 * A Vercel Build Output API route, run before Nitro's own: any path, when the
 * session cookie is there, gets the flag set in its query and carries on.
 */
export type SignedInRoute = {
  src: string;
  has: { type: "cookie"; key: string }[];
  transforms: {
    type: "request.query";
    op: "set";
    target: { key: string };
    args: string;
  }[];
  continue: true;
};

export function signedInRoutes(): SignedInRoute[] {
  return [
    {
      src: "^/(.*)$",
      has: [{ type: "cookie", key: SESSION_COOKIE }],
      transforms: [
        {
          type: "request.query",
          op: "set",
          target: { key: SIGNED_IN_FLAG },
          args: "1",
        },
      ],
      continue: true,
    },
  ];
}
