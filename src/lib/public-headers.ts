/**
 * For a public data page a logged-out visitor sees (M6 decision 3): the same
 * for everyone, so a CDN keeps it for a minute and serves a stale copy for
 * five while it fetches a new one (HLD §11.4). It never sets a cookie or
 * varies by viewer.
 *
 * `Vary: Cookie` keeps a signed-in reader of the same URL out of that copy: a
 * logged-out visitor sends no cookie, so they all share one entry, and a
 * signed-in one's request misses it and gets their own private answer.
 */
export const PUBLIC_CACHE = "public, s-maxage=60, stale-while-revalidate=300";

export const PUBLIC_VARY = "Cookie";

export const publicHeaders = () => ({
  "Cache-Control": PUBLIC_CACHE,
  Vary: PUBLIC_VARY,
});
