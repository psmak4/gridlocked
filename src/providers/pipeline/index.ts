import { createFinalizeHandler } from "@/jobs/finalize";
import { createPollHandler } from "@/jobs/poll";
import { createRosterHandler } from "@/jobs/roster";
import { createSyncCalendarHandler } from "@/jobs/sync-calendar";
import type { JobHandler } from "@/jobs/runner";
import type { ProviderClient } from "../http/client";
import { createJolpicaCalendarSource } from "./jolpica-calendar";
import { createJolpicaResultsSource } from "./jolpica-results";
import { createOpenF1ParticipantsSource } from "./openf1-participants";

export interface PipelineDeps {
  /**
   * Both clients are built (by the entry point) with the same database and
   * clock that `runDue` gets, so snapshots, the request log and the job's own
   * writes share one instant (HLD decision 20).
   */
  jolpica: ProviderClient;
  openf1: ProviderClient;
}

export type PipelineHandlers = Record<
  "sync_calendar" | "poll_session" | "finalize_check" | "roster_check",
  JobHandler
>;

/**
 * The handlers for the pipeline's job kinds, wired to the providers. This is
 * the one place the jobs meet the adapters (HLD §3.3 rule 2): the handlers in
 * `src/jobs` only know the ports in `src/jobs/ports.ts`.
 */
export function createPipelineHandlers(deps: PipelineDeps): PipelineHandlers {
  const results = createJolpicaResultsSource(deps.jolpica);
  return {
    sync_calendar: createSyncCalendarHandler(
      createJolpicaCalendarSource(deps.jolpica),
    ),
    poll_session: createPollHandler(results),
    finalize_check: createFinalizeHandler(results),
    roster_check: createRosterHandler(
      createOpenF1ParticipantsSource(deps.openf1),
    ),
  };
}
