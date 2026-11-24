/**
 * Publishes a legal document's approved text (src/identity/legal-text.ts) in
 * the database DATABASE_URL names, dated at its "now" (the replay clock when
 * CLOCK_MODE=replay). Safe to run again. Per environment, never a migration,
 * so the beta notice never reaches production.
 *
 *   CLOCK_MODE=replay DATABASE_URL=postgres://... pnpm legal:publish beta
 */
import { createDb } from "@/db/client";
import { publishLegal } from "@/identity/legal-publish";
import { assertClockMode, clockModeFromEnv } from "@/lib/resolve-clock";

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1) throw new Error("usage: pnpm legal:publish <kind>");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const mode = clockModeFromEnv(process.env);

  const handle = createDb(url);
  try {
    const db = handle.db();
    await assertClockMode(db, mode);
    const result = await publishLegal(db, mode, args[0]!);
    console.log(
      result.published
        ? `published ${args[0]} ${result.version} at ${result.at.toISOString()}`
        : `${args[0]} ${result.version} was already published; nothing written`,
    );
  } finally {
    await handle.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
