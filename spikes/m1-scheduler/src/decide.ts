import type { ParsedDueFile } from "./due-file";

export type TickDecision = { action: "sleep" } | { action: "wake" } | { action: "skip"; reason: "missing" | "malformed" };

// A bad or missing file never wakes Postgres: the hourly safety tick
// republishes it, so the worst case is a job running up to an hour late.
export function decideTick(due: ParsedDueFile, now: Date): TickDecision {
  if (!due.ok) return { action: "skip", reason: due.reason };
  const next = due.file.next_due_at;
  if (next === null || Date.parse(next) > now.getTime()) return { action: "sleep" };
  return { action: "wake" };
}
