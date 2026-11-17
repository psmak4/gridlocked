/**
 * What the `/auth-error` page makes of the `error` code Better Auth puts in
 * its redirect: an expired or used link (the page offers a new one), a banned
 * account, or anything else.
 */
const EXPIRED = ["invalid_token", "token_expired", "expired_token"];
const BANNED = ["banned", "banned_user"];

export type AuthErrorKind = "expired" | "banned" | "other";

export function authErrorKind(code: string | null | undefined): AuthErrorKind {
  const lower = (code ?? "").toLowerCase();
  if (EXPIRED.includes(lower)) return "expired";
  if (BANNED.includes(lower)) return "banned";
  return "other";
}
