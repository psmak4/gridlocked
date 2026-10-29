/**
 * Imports the recorded 2026 season (tests/fixtures/) into a database, the way
 * the pipeline would have learned it: raw snapshots, calendar, roster, seats,
 * entries, results with their status, and practice participants. See
 * `importSeason2026` in src/providers/import. It plans no jobs and finalizes
 * nothing, so every imported round stays `provisional`: the calendar sync
 * (HLD §4.5) plans jobs only for events still to finish, and leaves the
 * imported past rounds as they are rather than queueing a backlog of polls
 * and finalize checks for them. An admin finalizes them (M8) if need be.
 *
 *   pnpm tsx scripts/import-2026.ts --dry-run   in-memory database, prints the report
 *   DATABASE_URL=postgres://... pnpm tsx scripts/import-2026.ts
 *
 * Without `--dry-run` it needs DATABASE_URL and refuses to run without it.
 * Safe to run again: a second run of the import changes nothing. It is meant
 * for an empty or staging database: one that has polled live data (any
 * `provider_requests` row) is refused unless `--force` is given, because the
 * recorded bodies would overwrite newer results. Unknown arguments are
 * refused too, so a mistyped `--dry-run` can't reach a real database. The
 * clock is the shared one (CLOCK_MODE, default system), resolved once here.
 */
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import type { Db } from "@/db/types";
import { clockModeFromEnv, resolveClock } from "@/lib/resolve-clock";
import { importSeason2026 } from "@/providers/import/import-season";
import * as schema from "@/db/schema";
import { createTestDb } from "../tests/helpers/test-db";

const FIXTURES = fileURLToPath(new URL("../tests/fixtures", import.meta.url));

/**
 * A Neon (Postgres over WebSocket) connection. The driver is not a dependency
 * of the app yet, so it is loaded only here, by a name the type checker does
 * not resolve, and a missing one is a clear error instead of a crash.
 */
async function connect(
  url: string,
): Promise<{ db: Db; close(): Promise<void> }> {
  const driver = "@neondatabase/serverless";
  let neon: {
    Pool: new (opts: { connectionString: string }) => { end(): Promise<void> };
  };
  try {
    neon = await import(/* @vite-ignore */ driver);
  } catch {
    throw new Error(
      `${driver} is not installed: add it before importing into a real database, or use --dry-run`,
    );
  }
  const { drizzle } = await import("drizzle-orm/neon-serverless");
  const pool = new neon.Pool({ connectionString: url });
  return {
    db: drizzle(pool as never, { schema }) as unknown as Db,
    close: () => pool.end(),
  };
}

const KNOWN_ARGS = new Set(["--dry-run", "--force"]);

async function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => !KNOWN_ARGS.has(a));
  if (unknown.length > 0) {
    throw new Error(
      `unknown argument ${unknown.join(", ")}: use --dry-run and/or --force`,
    );
  }
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");
  const url = process.env.DATABASE_URL;
  if (!dryRun && !url) {
    throw new Error(
      "DATABASE_URL is not set: pass it in the environment, or use --dry-run for an in-memory database",
    );
  }

  const target = dryRun ? await createTestDb() : await connect(url as string);
  try {
    if (!force) {
      const polled = (await (target.db as Db).execute(
        sql`select 1 from provider_requests limit 1`,
      )) as { rows: unknown[] };
      if (polled.rows.length > 0) {
        throw new Error(
          "this database has polled live data (provider_requests is not empty): the import would overwrite newer results. Use --force to import anyway",
        );
      }
    }
    const clock = await resolveClock({
      mode: clockModeFromEnv(process.env),
      db: target.db as never,
    });
    const report = await importSeason2026(target.db as Db, clock, FIXTURES);
    console.log(
      `${dryRun ? "dry run (in-memory database)" : "imported"}:\n${JSON.stringify(report, null, 2)}`,
    );
  } finally {
    await target.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
