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
 *   pnpm import:2026 --dry-run   in-memory database, prints the report
 *   DATABASE_URL=postgres://... pnpm import:2026
 *
 * Without `--dry-run` it needs DATABASE_URL (the Neon database, through
 * `createDb`) and refuses to run without it.
 * Safe to run again: a second run of the import changes nothing. It is meant
 * for an empty or staging database: one that has polled live data (any
 * `provider_requests` row) is refused unless `--force` is given, because the
 * recorded bodies would overwrite newer results. Unknown arguments are
 * refused too, so a mistyped `--dry-run` can't reach a real database. It runs
 * in system mode only: it checks the database has no `simulated_clock` row
 * (a replay database) and refuses a CLOCK_MODE other than system.
 */
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import { createDb } from "@/db/client";
import {
  assertClockMode,
  clockModeFromEnv,
  resolveClock,
  type ClockDb,
} from "@/lib/resolve-clock";
import type { Db } from "@/db/types";
import { importSeason2026 } from "@/providers/import/import-season";

const FIXTURES = fileURLToPath(new URL("../tests/fixtures", import.meta.url));

type Target = { db: Db & ClockDb; close(): Promise<void> };

/**
 * `--dry-run` uses an in-memory PGlite database. It is loaded only then, so a
 * real import never pulls the test database (and its WASM) in.
 */
async function open(dryRun: boolean, url: string | undefined): Promise<Target> {
  if (dryRun) {
    const { createTestDb } = await import("../tests/helpers/test-db");
    const t = await createTestDb();
    return { db: t.db, close: t.close };
  }
  const handle = createDb(url as string);
  return { db: handle.db(), close: handle.close };
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
  if (clockModeFromEnv(process.env) !== "system") {
    throw new Error("the import runs in system mode: unset CLOCK_MODE");
  }

  const target = await open(dryRun, url);
  try {
    await assertClockMode(target.db, "system");
    if (!force) {
      const polled = await target.db.execute(
        sql`select 1 from provider_requests limit 1`,
      );
      if (polled.rows.length > 0) {
        throw new Error(
          "this database has polled live data (provider_requests is not empty): the import would overwrite newer results. Use --force to import anyway",
        );
      }
    }
    const clock = await resolveClock({ mode: "system", db: target.db });
    const report = await importSeason2026(target.db, clock, FIXTURES);
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
