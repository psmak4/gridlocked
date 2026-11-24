/**
 * Makes the empty, migrated database DATABASE_URL names the closed beta's
 * (M9 Task 13, docs/runbooks/beta.md): the 2026 game from round 1, open, with
 * the replay's clock running so round 1's Friday lands on BETA_FIRST_FRIDAY.
 * Refuses a database that isn't empty. Run by the Deploy staging workflow.
 *
 *   CLOCK_MODE=replay BETA_FIRST_FRIDAY=2027-02-19 STAFF_ACTOR=<you> \
 *   DATABASE_URL=postgres://... pnpm seed:beta
 */
import { fileURLToPath } from "node:url";
import { createDb } from "@/db/client";
import { systemClock } from "@/lib/clock";
import { clockModeFromEnv } from "@/lib/resolve-clock";
import { seedBeta } from "@/providers/replay/seed-beta";

const FIXTURES = fileURLToPath(new URL("../tests/fixtures", import.meta.url));

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  if (clockModeFromEnv(process.env) !== "replay") {
    throw new Error("the beta runs in replay mode: set CLOCK_MODE=replay");
  }
  const firstFriday = process.env.BETA_FIRST_FRIDAY?.trim();
  if (!firstFriday) throw new Error("BETA_FIRST_FRIDAY is not set");
  const actor = process.env.STAFF_ACTOR?.trim();
  if (!actor) throw new Error("STAFF_ACTOR is not set");

  const handle = createDb(url);
  try {
    const seeded = await seedBeta(handle.db(), systemClock.now(), {
      firstFriday,
      fixturesDir: FIXTURES,
      actor: { kind: "admin", label: actor },
    });
    console.log(
      `seeded: the replay's clock is at ${seeded.at.toISOString()} and running, and round 1's Friday lands on ${firstFriday}`,
    );
  } finally {
    await handle.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
