/**
 * The refusals our identity code throws. Kept apart from `viewer.ts`, which
 * imports the schema, so a module the browser also loads (the server-function
 * error scrub in `start.ts`) can check for one without pulling the database
 * code into the client bundle.
 */
export type IdentityErrorCode =
  | "unauthenticated"
  | "incomplete"
  | "read_only"
  | "unverified"
  | "inactive"
  // Usernames (DM 6.3): the four ways a name is refused, and the wait.
  | "format"
  | "reserved"
  | "held"
  | "taken"
  | "username_too_soon"
  // The profile (DM 6.2): a stale form, and values that aren't real.
  | "version_conflict"
  | "invalid_country"
  | "invalid_timezone"
  | "invalid_document"
  // Roles, staff access and impersonation (DM 6.4).
  | "forbidden"
  | "staff_two_factor_required"
  | "staff_session_unverified"
  | "invalid_code"
  | "rate_limited"
  | "no_such_user"
  | "role_reserved"
  | "last_admin"
  | "invalid_ban"
  | "cannot_impersonate"
  | "not_impersonating"
  // Trust levels (DM 6.5): a moderator's level outside 0–3.
  | "invalid_trust_level"
  // Export and deletion (DM 6.7): an export already open or made today, the
  // typed username that doesn't match, a sign-in too old to confirm by, and a
  // confirmation link that is expired, used or replaced.
  | "export_pending"
  | "export_too_soon"
  | "wrong_username"
  | "sign_in_again"
  | "invalid_link"
  // Two staff changes deadlocked, and the retries did too.
  | "try_again";

/** Carries a code and nothing personal: it can be logged and shown. */
export class IdentityError extends Error {
  constructor(readonly code: IdentityErrorCode) {
    super(code);
    this.name = "IdentityError";
  }
}
