import type { Db } from "@/db/types";
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

export interface ResultsSource {
  /**
   * Asks the provider for the session's results and stores the answer as a
   * snapshot (rate limited and logged by the shared client). `body` is opaque
   * to the job: it goes straight back to `normalize`.
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
