import { z } from "zod";

/**
 * The job kinds of the ingestion pipeline. Scoring and threads add theirs in
 * M4 and M7. `game_lock` and `game_open` are the game layer's (handlers in
 * `src/game/jobs.ts`). `normalize` and `validate` are reserved: the poll and finalize
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
  "game_lock",
  "game_open",
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

/**
 * `final` marks a check that finalizes the event. `held` is set on the
 * follow-up checks of a held event (1, 2, ...); the planned checks omit it.
 */
export const finalizePayload = z.object({
  eventId: z.string().min(1),
  afterHours: z.number().int().positive(),
  final: z.boolean(),
  held: z.number().int().positive().optional(),
});
export type FinalizePayload = z.infer<typeof finalizePayload>;

/**
 * `attempt` is absent on the planned check, then 1, 2, ... on the re-checks of
 * a session OpenF1 could not yet answer for.
 */
export const rosterPayload = z.object({
  eventId: z.string().min(1),
  sessionId: z.string().min(1),
  attempt: z.number().int().min(1).optional(),
});
export type RosterPayload = z.infer<typeof rosterPayload>;

// Dedupe keys (DM 2.10): the same work can never be queued twice, and a
// session time change moves the matching pending job through its key.

export const pollStartKey = (sessionId: string) => `poll:${sessionId}:start`;
export const pollAttemptKey = (sessionId: string, attempt: number) =>
  `poll:${sessionId}:${attempt}`;
export const finalizeKey = (eventId: string, afterHours: number) =>
  `finalize:${eventId}:+${afterHours}h`;
/** The `n`th follow-up of a final check that held the event. */
export const finalizeHeldKey = (eventId: string, n: number) =>
  `finalize:${eventId}:held:${n}`;
export const rosterKey = (eventId: string, kind: RosterKind) =>
  `roster:${eventId}:${kind}`;
/** The `n`th re-check of a roster check OpenF1 could not answer yet. */
export const rosterRetryKey = (
  eventId: string,
  kind: RosterKind,
  attempt: number,
) => `roster:${eventId}:${kind}:retry:${attempt}`;

export const syncCalendarPayload = z.object({
  season: z.number().int().positive(),
});
export type SyncCalendarPayload = z.infer<typeof syncCalendarPayload>;

/** One calendar sync per season per UTC day. */
export const syncCalendarKey = (season: number, day: string) =>
  `sync_calendar:${season}:${day}`;

/**
 * `afterTeamId` continues a lock after a batch of teams. `wait` is set (1, 2,
 * ...) on a lock job that put itself off: it ran before `lock_at`, or before
 * the event could lock. `sweep` is the UTC day (YYYY-MM-DD) of the planning
 * sweep that started the chain, for a lock whose own chain died; the chain's
 * later keys carry it, so none is a key the dead chain took.
 */
export const gameLockPayload = z.object({
  gameId: z.string().min(1),
  eventId: z.string().min(1),
  afterTeamId: z.string().min(1).optional(),
  wait: z.number().int().positive().optional(),
  sweep: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});
export type GameLockPayload = z.infer<typeof gameLockPayload>;

/** `attempt` is absent on the planned job, then 1, 2, ... on its re-checks. */
export const gameOpenPayload = z.object({
  gameId: z.string().min(1),
  eventId: z.string().min(1),
  attempt: z.number().int().positive().optional(),
});
export type GameOpenPayload = z.infer<typeof gameOpenPayload>;

export const gameLockKey = (gameId: string, eventId: string) =>
  `game_lock:${gameId}:${eventId}`;
/**
 * A lock sweep for the UTC day `day` (YYYY-MM-DD): queued by planning for an
 * open event past its `lock_at` with no lock job left alive.
 */
export const gameLockSweepKey = (
  gameId: string,
  eventId: string,
  day: string,
) => `game_lock:${gameId}:${eventId}:sweep:${day}`;
/** The chain's own key prefix: the lock's, or its sweep's for `sweep`. */
const lockChainKey = (gameId: string, eventId: string, sweep?: string) =>
  sweep === undefined
    ? gameLockKey(gameId, eventId)
    : gameLockSweepKey(gameId, eventId, sweep);
/** The batch of a lock that starts after the given team. */
export const gameLockAfterKey = (
  gameId: string,
  eventId: string,
  afterTeamId: string,
  sweep?: string,
) => `${lockChainKey(gameId, eventId, sweep)}:after:${afterTeamId}`;
/** The `n`th time a lock job put itself off. */
export const gameLockWaitKey = (
  gameId: string,
  eventId: string,
  n: number,
  sweep?: string,
) => `${lockChainKey(gameId, eventId, sweep)}:wait:${n}`;
export const gameOpenKey = (gameId: string, eventId: string) =>
  `game_open:${gameId}:${eventId}`;
/** The `n`th re-check of an open job that was not yet time. */
export const gameOpenRecheckKey = (
  gameId: string,
  eventId: string,
  n: number,
) => `game_open:${gameId}:${eventId}:${n}`;
