/**
 * Runs due jobs. Called from an entry point (cron trigger or admin route)
 * that has already resolved the clock once (HLD decision 20).
 */
import type { Clock } from "@/lib/clock";
import {
  claimNext,
  complete,
  fail,
  type Job,
  type JobKind,
  type JobsDb,
} from "./queue";

export type JobHandler = (
  job: Job,
  ctx: { db: JobsDb; clock: Clock },
) => Promise<void>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Claims and runs up to `maxJobs` due jobs, one at a time. A handler error
 * (or a missing handler) fails the job with its backoff; it never throws out
 * of here. `ran` counts jobs that succeeded, `failed` those that did not.
 */
export async function runDue(
  db: JobsDb,
  clock: Clock,
  handlers: Record<JobKind, JobHandler>,
  opts: { maxJobs: number; leaseMs: number },
): Promise<{ ran: number; failed: number }> {
  let ran = 0;
  let failed = 0;
  for (let i = 0; i < opts.maxJobs; i++) {
    const job = await claimNext(db, clock.now(), opts.leaseMs);
    if (!job) break;

    const handler = Object.hasOwn(handlers, job.kind)
      ? handlers[job.kind]
      : undefined;
    try {
      if (!handler) throw new Error(`no handler for kind ${job.kind}`);
      await handler(job, { db, clock });
      await complete(db, job.id, clock.now());
      ran++;
    } catch (error) {
      await fail(db, job.id, clock.now(), errorMessage(error));
      failed++;
    }
  }
  return { ran, failed };
}
