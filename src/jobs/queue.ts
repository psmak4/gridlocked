/**
 * The job queue (DM 2.10): enqueue, claim, complete and fail. Every function
 * takes `now` as a parameter (HLD decision 20); nothing here reads the time
 * or calls SQL `now()`.
 */
import { and, asc, eq, gte, inArray, lt, lte, or, sql } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { jobs } from "@/db/schema";
import { newId } from "@/lib/ids";

/** Narrowed to a union of known kinds in Task 10. */
export type JobKind = string;

export type Job = typeof jobs.$inferSelect;

/** Any Drizzle Postgres database: PGlite in tests, Neon in the app. */
export type JobsDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/** DM 2.10 leaves the retry limit open; this is the default. */
export const DEFAULT_MAX_ATTEMPTS = 5;

/** Backoff after the Nth failed attempt: 1, 5, then 15 minutes. */
const BACKOFF_MS = [1, 5, 15].map((minutes) => minutes * 60_000);

export function backoffMs(attempts: number): number {
  const index = Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1;
  return BACKOFF_MS[index]!;
}

/**
 * Inserts the job, or moves an existing `pending` or `failed` job with the
 * same (kind, dedupeKey) to the new `runAt` and `payload` (DM 2.10: a time
 * change updates `run_at`). A `running`, `succeeded` or `dead` job is left
 * alone. `created` says whether a new row was inserted.
 */
export async function enqueue(
  db: JobsDb,
  job: {
    kind: JobKind;
    dedupeKey: string;
    runAt: Date;
    payload: unknown;
    maxAttempts?: number;
  },
): Promise<{ id: string; created: boolean }> {
  const newJobId = newId();
  const [row] = await db
    .insert(jobs)
    .values({
      id: newJobId,
      kind: job.kind,
      dedupeKey: job.dedupeKey,
      runAt: job.runAt,
      payload: job.payload ?? {},
      maxAttempts: job.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    })
    .onConflictDoUpdate({
      target: [jobs.kind, jobs.dedupeKey],
      set: { runAt: job.runAt, payload: job.payload ?? {} },
      setWhere: inArray(jobs.status, ["pending", "failed"]),
    })
    .returning({ id: jobs.id });
  // On conflict RETURNING yields the existing row's id when it was updated,
  // and nothing when the existing job is running or finished.
  if (row) return { id: row.id, created: row.id === newJobId };

  const [existing] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.kind, job.kind), eq(jobs.dedupeKey, job.dedupeKey)));
  if (!existing) {
    throw new Error(`enqueue: job ${job.kind}/${job.dedupeKey} vanished`);
  }
  return { id: existing.id, created: false };
}

/**
 * Takes one due job in a single statement. Due means `pending` or `failed`
 * with `run_at <= now`, or `running` with an expired lease (a worker died)
 * and attempts left. `FOR UPDATE SKIP LOCKED` means two workers can never
 * take the same job. A job whose lease expired at `max_attempts` is never
 * reclaimed; `reapExpired` dead-letters it.
 */
export async function claimNext(
  db: JobsDb,
  now: Date,
  leaseMs: number,
): Promise<Job | null> {
  const candidate = db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      or(
        and(inArray(jobs.status, ["pending", "failed"]), lte(jobs.runAt, now)),
        and(
          eq(jobs.status, "running"),
          lte(jobs.lockedUntil, now),
          lt(jobs.attempts, jobs.maxAttempts),
        ),
      ),
    )
    .orderBy(asc(jobs.runAt), asc(jobs.id))
    .limit(1)
    .for("update", { skipLocked: true });

  const [claimed] = await db
    .update(jobs)
    .set({
      status: "running",
      attempts: sql`${jobs.attempts} + 1`,
      lockedUntil: new Date(now.getTime() + leaseMs),
      startedAt: now,
    })
    .where(eq(jobs.id, candidate))
    .returning();
  return claimed ?? null;
}

/**
 * Dead-letters `running` jobs whose lease expired with no attempts left (the
 * worker died on its last try, so `fail` never ran). Returns how many.
 */
export async function reapExpired(db: JobsDb, now: Date): Promise<number> {
  const reaped = await db
    .update(jobs)
    .set({
      status: "dead",
      lastError: "lease expired after max attempts",
      lockedUntil: null,
      finishedAt: now,
    })
    .where(
      and(
        eq(jobs.status, "running"),
        lte(jobs.lockedUntil, now),
        gte(jobs.attempts, jobs.maxAttempts),
      ),
    )
    .returning({ id: jobs.id });
  return reaped.length;
}

/**
 * Marks a claimed job succeeded. Fenced on the claimed `attempts`: returns
 * false (and changes nothing) if the job is no longer running under that
 * claim, e.g. its lease expired and another worker re-claimed it.
 */
export async function complete(
  db: JobsDb,
  job: Pick<Job, "id" | "attempts">,
  now: Date,
): Promise<boolean> {
  const rows = await db
    .update(jobs)
    .set({ status: "succeeded", finishedAt: now, lockedUntil: null })
    .where(
      and(
        eq(jobs.id, job.id),
        eq(jobs.status, "running"),
        eq(jobs.attempts, job.attempts),
      ),
    )
    .returning({ id: jobs.id });
  return rows.length > 0;
}

/**
 * Records a failed attempt of a claimed job. The job goes back to `failed`
 * and is retried at `now + backoff(attempts)`; once `attempts >=
 * max_attempts` it is `dead`. Fenced like `complete`: returns false and
 * changes nothing if the claim was lost.
 */
export async function fail(
  db: JobsDb,
  job: Job,
  now: Date,
  error: string,
): Promise<boolean> {
  const dead = job.attempts >= job.maxAttempts;
  const rows = await db
    .update(jobs)
    .set(
      dead
        ? {
            status: "dead",
            lastError: error,
            lockedUntil: null,
            finishedAt: now,
          }
        : {
            status: "failed",
            lastError: error,
            lockedUntil: null,
            runAt: new Date(now.getTime() + backoffMs(job.attempts)),
          },
    )
    .where(
      and(
        eq(jobs.id, job.id),
        eq(jobs.status, "running"),
        eq(jobs.attempts, job.attempts),
      ),
    )
    .returning({ id: jobs.id });
  return rows.length > 0;
}
