/**
 * The refusals a staff screen can show (M8 Task 3). A staff server function
 * answers `{ ok: false, error }` with one of these; the screen has words for
 * each, and anything else is `server_error`. Each task adds its own codes.
 * No imports, so the screens can load it.
 */
export const STAFF_ERROR_CODES = [
  "unauthenticated",
  "forbidden",
  "read_only",
  "staff_two_factor_required",
  "staff_session_unverified",
  "reason_required",
  "stale",
  "not_found",
  "invalid",
  "lock_in_past",
  "event_locked",
  "session_final",
  "dry_run_required",
  "game_not_running",
  "prices_frozen",
  "item_mismatch",
  "server_error",
] as const;
export type StaffErrorCode = (typeof STAFF_ERROR_CODES)[number];

/** The longest reason a staff write takes (M8). */
export const REASON_MAX = 500;

/** What a staff server function answers. */
export type StaffResult<T> =
  { ok: true; value: T } | { ok: false; error: StaffErrorCode };

/** A staff function's own refusal: its code, and a detail for the workflow. */
export class StaffError extends Error {
  /** `detail` is for logs and the staff workflow; a screen shows the code's words. */
  constructor(
    readonly code: StaffErrorCode,
    detail?: string,
  ) {
    super(detail ?? code);
    this.name = "StaffError";
  }
}

/** A staff write's reason, trimmed; blank or over 500 is `reason_required`. */
export function staffReason(reason: string): string {
  const trimmed = reason.trim();
  if (!trimmed || trimmed.length > REASON_MAX) {
    throw new StaffError("reason_required");
  }
  return trimmed;
}

export function isStaffErrorCode(code: string): code is StaffErrorCode {
  return (STAFF_ERROR_CODES as readonly string[]).includes(code);
}

/** The words for a refusal, on any staff screen. */
export const STAFF_ERROR_WORDS: Record<StaffErrorCode, string> = {
  unauthenticated: "You've been signed out. Sign in again to carry on.",
  forbidden: "Your role can't do this.",
  read_only: "Staff tools are read-only while you're looking as someone else.",
  staff_two_factor_required: "Staff tools need two-step sign-in.",
  staff_session_unverified:
    "Enter your two-step code on the security page to unlock staff tools.",
  reason_required: "Give a reason. It's saved in the audit log.",
  stale: "Someone else dealt with this first.",
  not_found: "This isn't here any more.",
  invalid: "Something in the form isn't right. Check it and try again.",
  lock_in_past: "A lock can't move to a time that has passed.",
  event_locked: "This event has locked, so it can't be cancelled here.",
  session_final:
    "This session is final, so the provider isn't checked again. Add a correction instead.",
  dry_run_required:
    "There's no dry run to act on. Start one, and check what it would change first.",
  game_not_running: "This game isn't running, so there's nothing to re-score.",
  prices_frozen:
    "This event has opened, so its prices are fixed. Change them for the next one.",
  item_mismatch: "That action doesn't belong to this item.",
  server_error: "Something went wrong on our side. Try again.",
};
