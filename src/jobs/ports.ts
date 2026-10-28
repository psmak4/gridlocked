import type { Db } from "@/db/types";
import type { Clock } from "@/lib/clock";
import type { SessionKind } from "@/results/types";

// What the pipeline jobs need from "the outside". `src/jobs` never imports a
// provider (HLD §3.3 rule 2): the adapters in `src/providers/pipeline` implement
// these ports and `createPipelineHandlers` hands them to the handlers.

export interface PipelineSession {
  id: string;
  kind: SessionKind;
  eventId: string;
  seasonId: string;
}

/**
 * The provider could not answer: a network failure, a timeout, a 5xx or a
 * rate limit that did not clear. The poll and finalize jobs treat it as "no
 * news" and carry on; any other error is a bug or a database failure and
 * still fails the job.
 */
export class ProviderUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ProviderUnavailableError";
  }
}

export interface ResultsSource {
  /**
   * Asks the provider for the session's results and stores the answer as a
   * snapshot (rate limited and logged by the shared client). `body` is opaque
   * to the job: it goes straight back to `normalize`. Throws
   * `ProviderUnavailableError` when the provider cannot be reached.
   */
  fetch(
    db: Db,
    session: PipelineSession,
    jobId: string,
  ): Promise<{ snapshotId: string; body: unknown }>;
  /** Turns a fetched answer into `results` rows (DM 2.4, 2.5). */
  normalize(
    db: Db,
    now: Date,
    session: PipelineSession,
    snapshotId: string,
    body: unknown,
  ): Promise<{ changed: number }>;
}

export interface ParticipantsSource {
  /** Fetches who took part in a practice session and stores them (DM 2.8). */
  refresh(
    db: Db,
    now: Date,
    session: PipelineSession,
    jobId: string,
  ): Promise<void>;
}

export interface CalendarSyncSource {
  /**
   * Fetches the season's calendar, drivers and constructors and applies them
   * to the reference tables (syncCalendar, syncDrivers, syncConstructors).
   */
  sync(db: Db, clock: Clock, season: number, jobId: string): Promise<void>;
}
