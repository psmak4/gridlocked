// Why a community write was refused. Each code maps to wave 4's copy on the
// screen; anything else a server function meets is `server_error`.

export const COMMUNITY_ERROR_CODES = [
  "trust_too_low",
  "rate_limited",
  "slow_mode",
  "muted",
  "chat_banned",
  "thread_banned",
  "too_many_links",
  "links_not_allowed",
  "too_many_mentions",
  "duplicate",
  "blocked",
  "too_long",
  "thread_locked",
  "chat_closed",
  "not_found",
  "forbidden",
] as const;

export type CommunityErrorCode = (typeof COMMUNITY_ERROR_CODES)[number];

/** A refusal, as every community function returns one. */
export type CommunityRefusal = {
  ok: false;
  error: CommunityErrorCode;
  /** For `rate_limited` and `slow_mode`: when trying again can work. */
  retryAfterSeconds?: number;
};

export const refuse = (
  error: CommunityErrorCode,
  retryAfterSeconds?: number,
): CommunityRefusal =>
  retryAfterSeconds === undefined
    ? { ok: false, error }
    : { ok: false, error, retryAfterSeconds };
