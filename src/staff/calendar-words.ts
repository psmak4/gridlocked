/**
 * The calendar screen's words (M8 Task 5). Everything is in UTC, as the
 * board says ("times in UTC"). No imports, so the browser can load it.
 */

const fmt = (options: Intl.DateTimeFormatOptions) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", ...options });
const dayMonth = fmt({ day: "numeric", month: "short" });
const day = fmt({ day: "numeric" });
const month = fmt({ month: "short" });
const weekday = fmt({ weekday: "short" });
const clock = fmt({ hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

/** "27–29 Mar", or "30 Oct – 1 Nov" across a month; "–" with no sessions. */
export function utcDates(start: Date | null, end: Date | null): string {
  if (!start || !end) return "–";
  if (month.format(start) === month.format(end)) {
    return `${day.format(start)}–${dayMonth.format(end)}`;
  }
  return `${dayMonth.format(start)} – ${dayMonth.format(end)}`;
}

/** "Sat 20:00": the table's lock column. */
export function utcLock(at: Date): string {
  return `${weekday.format(at)} ${clock.format(at)}`;
}

/** "Sat 31 Oct, 20:00 UTC": a lock or session time in the panel. */
export function utcLong(at: Date): string {
  return `${weekday.format(at)} ${dayMonth.format(at)}, ${clock.format(at)} UTC`;
}

/** A `datetime-local` input's value for `at`, read as UTC. */
export function toUtcInput(at: Date): string {
  return at.toISOString().slice(0, 16);
}

/** A `datetime-local` value read as UTC, or null if it isn't one. */
export function fromUtcInput(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const at = new Date(`${value}:00.000Z`);
  return Number.isNaN(at.getTime()) ? null : at;
}

export type EventBadge = {
  label: "Cancelled" | "Completed" | "Locked" | "Next" | "Scheduled";
  tone: "neutral" | "caution" | "live";
};

/** The status column: the next event to lock is `Next`. */
export function eventBadge(
  event: { status: string; lockAt: Date },
  now: Date,
  isNext: boolean,
): EventBadge {
  if (event.status === "cancelled")
    return { label: "Cancelled", tone: "caution" };
  if (event.status === "completed")
    return { label: "Completed", tone: "neutral" };
  if (event.lockAt <= now) return { label: "Locked", tone: "neutral" };
  return isNext
    ? { label: "Next", tone: "live" }
    : { label: "Scheduled", tone: "neutral" };
}

/** The statuses staff set. `live` and `completed` are the clock's. */
export const STAFF_SESSION_STATUSES = [
  "scheduled",
  "suspended",
  "abandoned",
  "cancelled",
] as const;
export type StaffSessionStatus = (typeof STAFF_SESSION_STATUSES)[number];

/** A session status in words. */
export const SESSION_STATUS_WORDS: Record<string, string> = {
  scheduled: "Scheduled",
  live: "Live",
  suspended: "Suspended",
  completed: "Completed",
  abandoned: "Abandoned",
  cancelled: "Cancelled",
};
