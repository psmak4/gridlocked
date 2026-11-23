/**
 * Where `pnpm import:2026` may write (M9 Task 5). In system mode, as before:
 * a database with no `simulated_clock` row, that hasn't polled live data
 * unless `force` says so. In replay mode, for the hosted beta: a replay
 * database (its `simulated_clock` set first) that has never polled, `force`
 * or not, since its results are meant to come from its own polls as the
 * replay reaches them.
 */
import { sql } from "drizzle-orm";
import {
  assertClockMode,
  type ClockDb,
  type ClockMode,
} from "@/lib/resolve-clock";

export async function checkImportTarget(
  db: ClockDb,
  mode: ClockMode,
  opts: { force: boolean },
): Promise<void> {
  await assertClockMode(db, mode);
  if (mode === "system" && opts.force) return;
  const polled = await db.execute(sql`select 1 from provider_requests limit 1`);
  if (polled.rows.length === 0) return;
  throw new Error(
    mode === "replay"
      ? "this replay database has polled live data (provider_requests is not empty): import into a fresh one"
      : "this database has polled live data (provider_requests is not empty): the import would overwrite newer results. Use --force to import anyway",
  );
}
