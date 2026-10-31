/**
 * The staff roster actions (src/staff/roster.ts) from the command line, until
 * M8's screens: a substitution for one event, or a seat change from an event
 * onward. On staging, run it through the `staff-action` workflow.
 *
 *   STAFF_EVENT=2026/19 \
 *   STAFF_CHANGE='{"in":"ryo_hirakawa","team":"haas","car":<n>,"out":"ocon"}' \
 *   STAFF_REASON='Hirakawa replaces Ocon from FP3' STAFF_ACTOR=<you> \
 *   STAFF_DRY_RUN=false DATABASE_URL=postgres://... pnpm staff substitute
 *
 *   STAFF_CHANGE='[{"driver":"ocon","team":null},{"driver":"x","team":"haas","car":<n>}]' \
 *   ... pnpm staff seats
 *
 * Keys are Jolpica's. Without STAFF_DRY_RUN=false it only resolves the keys
 * and prints what it would do. It runs in system mode only: it refuses a
 * replay database and a CLOCK_MODE other than system.
 */
import { createDb } from "@/db/client";
import {
  assertClockMode,
  clockModeFromEnv,
  resolveClock,
} from "@/lib/resolve-clock";
import { rematchParticipants } from "@/providers/openf1/participants";
import { parseStaffEnv, runStaffCommand } from "@/staff/cli";

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    throw new Error(
      "usage: pnpm staff <substitute|seats> (inputs in STAFF_* variables)",
    );
  }
  const cmd = parseStaffEnv(args[0], process.env);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  if (clockModeFromEnv(process.env) !== "system") {
    throw new Error("staff actions run in system mode: unset CLOCK_MODE");
  }

  const handle = createDb(url);
  const db = handle.db();
  try {
    await assertClockMode(db, "system");
    const clock = await resolveClock({ mode: "system", db });
    const report = await runStaffCommand(db, clock.now(), cmd, {
      rematchParticipants,
    });
    console.log(
      `${report.dryRun ? "dry run, nothing written" : "done"}:\n${JSON.stringify(report, null, 2)}`,
    );
  } finally {
    await handle.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
