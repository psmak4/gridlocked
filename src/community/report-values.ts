// The report lists (DM 5.8), with no database code, so the report sheet and
// the inputs can import them; the schema re-exports them.

/** Everything a report can be about. M7 takes the first three. */
export const REPORT_TARGET_TYPES = [
  "post",
  "thread",
  "chat_message",
  "user",
  "team_name",
  "league_name",
] as const;
export type ReportTargetType = (typeof REPORT_TARGET_TYPES)[number];

/** What M7 takes reports on. */
export const REPORTABLE_TYPES = ["post", "thread", "chat_message"] as const;
export type ReportableType = (typeof REPORTABLE_TYPES)[number];

/** `copyright` covers DMCA notices (HLD §13.6). */
export const REPORT_REASONS = [
  "spam",
  "abuse",
  "spoiler",
  "off_topic",
  "illegal",
  "copyright",
  "other",
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

/** A report's note, at most. */
export const REPORT_NOTE_MAX = 1000;
