import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { createdAt, oneOf } from "./helpers";

// The job table (DM 2.10): one table for all background work. It sits below
// the results layer; results tables may point at it, never the other way.

export const JOB_STATUSES = [
  "pending",
  "running",
  "succeeded",
  "failed",
  "dead",
] as const;

/**
 * DM 2.10. `kind` has no CHECK list: new job kinds are code-only changes
 * (DM 2.15). Each kind has a Zod schema for `payload` in application code.
 */
export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey(),
    kind: text("kind").notNull(),
    /** Unique with `kind`, so the same work cannot be queued twice. */
    dedupeKey: text("dedupe_key").notNull(),
    payload: jsonb("payload").notNull().default({}),
    /** When the job becomes due. Supplied by the app from its clock. */
    runAt: timestamp("run_at", { withTimezone: true }).notNull(),
    status: text("status", { enum: JOB_STATUSES }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull(),
    /** A lease: when it runs out, another worker may take the job. */
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastError: text("last_error"),
    /**
     * The job that spawned this one, for fan-out. A diagnostic pointer: SET
     * NULL, so a succeeded parent can be pruned while a dead child stays.
     */
    parentJobId: uuid("parent_job_id").references((): AnyPgColumn => jobs.id, {
      onDelete: "set null",
    }),
    createdAt: createdAt(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    unique("jobs_kind_dedupe_key_unique").on(t.kind, t.dedupeKey),
    check("jobs_status_check", oneOf(t.status, JOB_STATUSES)),
    // The claim query (pending and failed rows) and the due-times file.
    index("jobs_run_at_pending_idx")
      .on(t.runAt)
      .where(sql`${t.status} in ('pending', 'failed')`),
    // Pruning and the admin "stuck or dead jobs" view.
    index("jobs_status_finished_at_idx").on(t.status, t.finishedAt),
  ],
);
