import { z } from "zod";

/**
 * The job kinds of the ingestion pipeline. Scoring and threads add theirs in
 * M4 and M7. `normalize` and `validate` are reserved: the poll and finalize
 * jobs run both steps inline, so nothing enqueues them yet.
 *
 * `queue.ts` keeps `JobKind = string` so the generic queue and its tests stay
 * free of this list; handler maps for this union are `Record<JobKind,
 * JobHandler>`-compatible.
 */
export const JOB_KINDS = [
  "sync_calendar",
  "poll_session",
  "normalize",
  "validate",
  "finalize_check",
  "roster_check",
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

/** Session kinds with a poll job: the ones Jolpica serves results for. */
export const POLLED_KINDS = ["qualifying", "sprint", "race"] as const;
export type PolledKind = (typeof POLLED_KINDS)[number];

/** Practice sessions whose participants feed the roster check (HLD §8.2). */
export const ROSTER_KINDS = ["fp2", "fp3"] as const;
export type RosterKind = (typeof ROSTER_KINDS)[number];

// Payloads (DM 2.10: a Zod schema per kind). Ids only: the handlers read the
// current state from the database.

/** `attempt` is 0 for the planned start job, then 1, 2, ... */
export const pollPayload = z.object({
  sessionId: z.string().min(1),
  attempt: z.number().int().min(0),
});
export type PollPayload = z.infer<typeof pollPayload>;

/** `final` marks the last check, which finalizes the event. */
export const finalizePayload = z.object({
  eventId: z.string().min(1),
  afterHours: z.number().int().positive(),
  final: z.boolean(),
});
export type FinalizePayload = z.infer<typeof finalizePayload>;

export const rosterPayload = z.object({
  eventId: z.string().min(1),
  sessionId: z.string().min(1),
});
export type RosterPayload = z.infer<typeof rosterPayload>;

// Dedupe keys (DM 2.10): the same work can never be queued twice, and a
// session time change moves the matching pending job through its key.

export const pollStartKey = (sessionId: string) => `poll:${sessionId}:start`;
export const pollAttemptKey = (sessionId: string, attempt: number) =>
  `poll:${sessionId}:${attempt}`;
export const finalizeKey = (eventId: string, afterHours: number) =>
  `finalize:${eventId}:+${afterHours}h`;
export const rosterKey = (eventId: string, kind: RosterKind) =>
  `roster:${eventId}:${kind}`;
