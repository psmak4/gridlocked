/**
 * Where the signed-in gate (`__root.tsx`) sends someone, or null to let them
 * through. Public pages stay public: a logged-out visitor is never touched.
 *
 * A signed-in person who hasn't finished (no username, no age confirmation or
 * a document still to accept) can do nothing but finish, read the terms,
 * take their data, or leave. A finished one has no use for the sign-in pages.
 */
export type GateAccount = { complete: boolean };

/** Pages an unfinished account may open. */
const OPEN_TO_UNFINISHED = [
  /^\/welcome$/,
  /^\/legal\/[^/]+$/,
  /^\/auth-error$/,
  /^\/check-email$/,
  /^\/reset-password$/,
  /^\/forgot-password$/,
  // Ruling 52: leaving, and taking your data with you, wait on nothing. The
  // deletion link's token is the proof, whatever else is unfinished.
  /^\/settings\/delete$/,
  /^\/settings\/delete\/confirm$/,
  /^\/settings\/data$/,
];

/** Pages a finished account is sent home from. */
const FOR_NEWCOMERS = [/^\/sign-up(\/.*)?$/, /^\/sign-in$/, /^\/welcome$/];

export function gateRedirect(
  pathname: string,
  account: GateAccount | null,
): "/" | "/welcome" | null {
  if (!account) return null;
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (account.complete) {
    return FOR_NEWCOMERS.some((re) => re.test(path)) ? "/" : null;
  }
  return OPEN_TO_UNFINISHED.some((re) => re.test(path)) ? null : "/welcome";
}

/**
 * Pages for someone signed in (M6): a logged-out visitor is sent to sign in
 * first, and comes back after. The weekend hub (`/weekend`) and the prices
 * (`/prices`, `/prices/how`) stay public and cacheable (M6 decision 3), like
 * every page not listed here.
 */
const SIGN_IN_FIRST = [/^\/team(\/.*)?$/, /^\/leagues(\/.*)?$/];

/**
 * Where to come back to after signing in, when a logged-out visitor opens a
 * sign-in-first page, or null to let them through.
 */
export function signInFirst(
  pathname: string,
  search: string,
  account: GateAccount | null,
): string | null {
  if (account) return null;
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return SIGN_IN_FIRST.some((re) => re.test(path)) ? path + search : null;
}

/** Longer than any path the site makes: a `next` past it is dropped. */
const MAX_NEXT = 512;

/**
 * `next` from the sign-in page's address, if it is a path on this site to go
 * back to: one leading slash (never `//` or `/\`, which a browser reads as
 * another host), no control characters, and not a sign-in page itself.
 */
export function safeNext(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > MAX_NEXT) return undefined;
  if (!/^\/(?![/\\])/.test(value)) return undefined;
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return undefined;
  if (/^\/sign-(in|up)(?=$|[/?#])/.test(value)) return undefined;
  return value;
}
