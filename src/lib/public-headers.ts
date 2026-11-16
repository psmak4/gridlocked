/**
 * For a public data page a logged-out visitor sees (M6 decision 3): the same
 * for everyone, so a CDN keeps it for a minute and serves a stale copy for
 * five while it fetches a new one (HLD §11.4). It never reads a session,
 * sets a cookie or varies by viewer.
 */
export const PUBLIC_CACHE = "public, s-maxage=60, stale-while-revalidate=300";

export const publicHeaders = () => ({ "Cache-Control": PUBLIC_CACHE });
