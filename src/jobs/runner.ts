/**
 * Runs due jobs. Called from an entry point (cron trigger or admin route)
 * that has already resolved the clock once (HLD decision 20).
 */
import type { Clock } from "@/lib/clock";
import {
  claimNext,
  complete,
  fail,
  reapExpired,
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
 * Dead-letters exhausted expired leases, then claims and runs up to `maxJobs`
 * due jobs, one at a time. A handler error (or a missing handler) fails the
 * job with its backoff; it never throws out of here. `ran` counts jobs that
 * succeeded, `failed` those that failed, and `lost` those whose result was
 * fenced out because another worker re-claimed the job.
 *
 * Handlers must be idempotent and finish within `leaseMs`: there is no
 * heartbeat yet, so a slower handler can be re-claimed and run twice.
 */
export async function runDue(
  db: JobsDb,
  clock: Clock,
  handlers: Record<JobKind, JobHandler>,
  opts: { maxJobs: number; leaseMs: number },
): Promise<{ ran: number; failed: number; lost: number }> {
  let ran = 0;
  let failed = 0;
  let lost = 0;
  await reapExpired(db, clock.now());
  for (let i = 0; i < opts.maxJobs; i++) {
    const job = await claimNext(db, clock.now(), opts.leaseMs);
    if (!job) break;

    const handler = Object.hasOwn(handlers, job.kind)
      ? handlers[job.kind]
      : undefined;
    let error: string | undefined;
    try {
      if (!handler) throw new Error(`no handler for kind ${job.kind}`);
      await handler(job, { db, clock });
    } catch (e) {
      error = errorMessage(e);
    }

    if (error === undefined) {
      if (await complete(db, job, clock.now())) ran++;
      else lost++;
    } else if (await fail(db, job, clock.now(), error)) {
      failed++;
    } else {
      lost++;
    }
  }
  return { ran, failed, lost };
}
