import { nextDueFile, type DueFile } from "./due-file";
import type { Bucket } from "./s3";
import type { Sql } from "./neon-sql";

export const DUE_KEY = "due-times.json";

// One UPDATE claims every due job; its row locks make claiming exactly-once
// even when two ticks for the same minute overlap.
export async function claimDueJobs(sql: Sql, now: Date): Promise<{ id: string; kind: string }[]> {
  return sql(
    "UPDATE spike_jobs SET status = 'running', claimed_at = $1 WHERE status = 'pending' AND run_at <= $1 RETURNING id, kind",
    [now.toISOString()],
  );
}

export async function finishJobs(sql: Sql, ids: string[], now: Date): Promise<void> {
  if (ids.length === 0) return;
  await sql("UPDATE spike_jobs SET status = 'done', done_at = $1 WHERE id = ANY($2::uuid[])", [now.toISOString(), ids]);
}

export async function publishDueFile(bucket: Bucket, sql: Sql, now: Date): Promise<DueFile> {
  const rows = await sql<{ run_at: string }>("SELECT run_at FROM spike_jobs WHERE status = 'pending'");
  const file = nextDueFile(rows.map((r) => new Date(r.run_at)), now);
  await bucket.put(DUE_KEY, JSON.stringify(file));
  return file;
}
