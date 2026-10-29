/**
 * The due-times file (HLD §4.5, M1 result). The scheduler tick reads this one
 * small object every minute to decide whether to wake Postgres, so a minute
 * with nothing due never opens a database connection. The file is rebuilt from
 * the job table after every wake, by the safety tick, and whenever a caller
 * outside a tick moves the earliest due time earlier.
 */
import { sql } from "drizzle-orm";
import type { ClockDb } from "@/lib/resolve-clock";

/** Where the production adapter keeps the file (Neon Object Storage). */
export const DUE_BUCKET = "scheduler";
export const DUE_KEY = "due-times.json";

/** The published shape (M1). `next_due_at` is null when nothing is due. */
export type DueFile = {
  version: 1;
  generated_at: string;
  next_due_at: string | null;
};

export type ParsedDueFile =
  { ok: true; file: DueFile } | { ok: false; reason: "missing" | "malformed" };

export type TickDecision =
  | { action: "sleep" }
  | { action: "wake" }
  | { action: "skip"; reason: "missing" | "malformed" };

/**
 * The object store behind the file. The production adapter is S3 against Neon
 * Object Storage (`src/providers/storage/due-store.ts`); tests use a map.
 * `get` returns null for a missing object and throws on any other failure.
 */
export type DueStore = {
  get(key: string): Promise<string | null>;
  put(key: string, body: string): Promise<void>;
};

// An ISO-8601 instant with an explicit offset, matching app_now()'s rule.
const ISO_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function isInstant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    ISO_INSTANT.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

export function parseDueFile(text: string | null): ParsedDueFile {
  if (text === null) return { ok: false, reason: "missing" };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof data !== "object" || data === null) {
    return { ok: false, reason: "malformed" };
  }
  const { version, generated_at, next_due_at } = data as Record<
    string,
    unknown
  >;
  if (version !== 1 || !isInstant(generated_at)) {
    return { ok: false, reason: "malformed" };
  }
  if (next_due_at !== null && !isInstant(next_due_at)) {
    return { ok: false, reason: "malformed" };
  }
  return { ok: true, file: { version: 1, generated_at, next_due_at } };
}

/**
 * A bad or missing file is never a reason to run jobs: `skip` means "do not
 * trust the file". The tick answers it by rebuilding the file from the job
 * table (see `tick`); the safety tick is the backstop.
 */
export function decideTick(parsed: ParsedDueFile, now: Date): TickDecision {
  if (!parsed.ok) return { action: "skip", reason: parsed.reason };
  const next = parsed.file.next_due_at;
  if (next === null || Date.parse(next) > now.getTime()) {
    return { action: "sleep" };
  }
  return { action: "wake" };
}

export function nextDueFile(dueAts: Date[], now: Date): DueFile {
  const earliest = dueAts.reduce<Date | null>(
    (min, t) => (min === null || t < min ? t : min),
    null,
  );
  return {
    version: 1,
    generated_at: now.toISOString(),
    next_due_at: earliest?.toISOString() ?? null,
  };
}

/**
 * The earliest moment a job becomes (or stays) claimable: `run_at` of pending
 * and failed jobs, `locked_until` of running ones (that is when a dead
 * worker's lease expires), or null. Two index-friendly subselects joined by
 * `least`, which ignores nulls: the first is the partial index
 * `jobs_run_at_pending_idx`, the second reads only the few running rows.
 * Formatted as ISO 8601 UTC in SQL so it does not depend on the driver.
 */
async function earliestDueAt(db: ClockDb): Promise<Date | null> {
  const { rows } = await db.execute(sql`
    select to_char(
      least(
        (select min(run_at) from jobs where status in ('pending', 'failed')),
        (select min(locked_until) from jobs
          where status = 'running' and locked_until is not null)
      ) at time zone 'UTC',
      'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
    ) as next_due_at
  `);
  const value = (rows[0] as { next_due_at?: unknown } | undefined)?.next_due_at;
  return typeof value === "string" ? new Date(value) : null;
}

/** Rebuilds the file from the job table and writes it. */
export async function publishDueTimes(
  db: ClockDb,
  store: DueStore,
  now: Date,
): Promise<DueFile> {
  const earliest = await earliestDueAt(db);
  const file = nextDueFile(earliest ? [earliest] : [], now);
  await store.put(DUE_KEY, JSON.stringify(file));
  return file;
}

/**
 * For callers outside a tick (an admin action that enqueues a job): the tick
 * already republishes after every wake, so jobs enqueued by handlers need
 * nothing more. Writes the file only when `runAt` is earlier than the stored
 * `next_due_at` (or the file says nothing is due). A missing or malformed file
 * is rebuilt from the job table instead, since `runAt` alone may not be the
 * earliest. Returns whether the file was written.
 */
export async function republishIfEarlier(
  db: ClockDb,
  store: DueStore,
  now: Date,
  runAt: Date,
): Promise<boolean> {
  const parsed = parseDueFile(await store.get(DUE_KEY));
  if (!parsed.ok) {
    await publishDueTimes(db, store, now);
    return true;
  }
  const stored = parsed.file.next_due_at;
  if (stored !== null && Date.parse(stored) <= runAt.getTime()) return false;
  await store.put(DUE_KEY, JSON.stringify(nextDueFile([runAt], now)));
  return true;
}
