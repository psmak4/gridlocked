/**
 * Where the signed-in gate (`__root.tsx`) sends someone, or null to let them
 * through. Public pages stay public: a logged-out visitor is never touched.
 *
 * A signed-in person who hasn't finished (no username, no age confirmation or
 * a document still to accept) can do nothing but finish, read the terms, or
 * leave. A finished one has no use for the sign-in pages.
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
  // The deletion link: its token is the proof, whatever else is unfinished.
  /^\/settings\/delete\/confirm$/,
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
