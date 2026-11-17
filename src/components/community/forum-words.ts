// The forum screens' words (wave 4). Pure, so the screens and their tests
// share them. Refusals have no canvas copy of their own; these say what
// happened and what to do, in the design system's voice.
import type { CommunityErrorCode, CommunityRefusal } from "@/community/errors";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "now", "5 min", "3 h", "2 d": how long ago, as a row says it. */
export function ago(iso: string, nowMs: number): string {
  const ms = nowMs - Date.parse(iso);
  if (ms < MINUTE) return "now";
  if (ms < HOUR) return `${Math.floor(ms / MINUTE)} min`;
  if (ms < DAY) return `${Math.floor(ms / HOUR)} h`;
  return `${Math.floor(ms / DAY)} d`;
}

const number = new Intl.NumberFormat("en-GB");

export const repliesWords = (n: number) =>
  `${number.format(n)} ${n === 1 ? "reply" : "replies"}`;

/** "late_braker · 86 replies · 3 h" */
export function threadMeta(
  row: { author: string | null; replyCount: number; lastActivityAt: string },
  nowMs: number,
): string {
  return [
    row.author,
    repliesWords(row.replyCount),
    ago(row.lastActivityAt, nowMs),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** "2 minutes", "6 seconds" */
function wait(seconds: number): string {
  if (seconds < 60) return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

const WORDS: Record<CommunityErrorCode, string> = {
  trust_too_low: "Your account can't do that yet. Keep reading and replying.",
  rate_limited: "You're posting fast. Try again shortly.",
  slow_mode: "Slow mode is on. Try again shortly.",
  muted: "You're muted for now, so you can't post.",
  chat_banned: "You can't send chat messages for now.",
  thread_banned: "You can't start threads for now.",
  too_many_links: "That's more links than your account can post at once.",
  links_not_allowed: "New accounts can't post links yet.",
  too_many_mentions: "That mentions too many people at once.",
  duplicate: "You've already posted that.",
  blocked: "That can't be posted here. Check the community rules.",
  too_long: "That's too long.",
  thread_locked: "This thread is locked.",
  chat_closed: "Chat is closed for this session.",
  not_found: "That post isn't there any more.",
  forbidden: "You can't do that.",
};

/** A refusal in words, with the wait when there is one. */
export function refusalWords(refusal: CommunityRefusal): string {
  const after = refusal.retryAfterSeconds;
  if (after !== undefined && refusal.error === "rate_limited") {
    return `You're posting fast. Try again in ${wait(after)}.`;
  }
  if (after !== undefined && refusal.error === "slow_mode") {
    return `You can send again in ${wait(after)}.`;
  }
  return WORDS[refusal.error];
}

/** When a write throws instead of refusing (signed out, offline). */
export const FAILED = "That didn't go through. Try again.";
