/**
 * Applies the migrations in src/db/migrations to a real Postgres (Neon), with
 * the drizzle migrator for the WebSocket driver, and prints which ones it
 * applied.
 *
 *   DATABASE_URL=postgres://... pnpm db:migrate
 *
 * Use the DIRECT (unpooled) connection string: the migrator runs everything in
 * one transaction. The script refuses to run without DATABASE_URL. It never
 * prints the URL. Safe to run again: with nothing new to apply it says so.
 * Migration 0003 creates the `btree_gist` extension, so the role needs to be
 * allowed to (Neon's owner role is).
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import { migrate } from "drizzle-orm/neon-serverless/migrator";

const MIGRATIONS = fileURLToPath(
  new URL("../src/db/migrations", import.meta.url),
);

/** Each migration's journal tag and the time drizzle stores for it. */
async function readJournal(): Promise<Array<{ tag: string; when: number }>> {
  const text = await readFile(`${MIGRATIONS}/meta/_journal.json`, "utf8");
  return (JSON.parse(text) as { entries: Array<{ tag: string; when: number }> })
    .entries;
}

/** The `created_at` of the latest applied migration; 0 on a fresh database. */
async function latestApplied(pool: Pool): Promise<number> {
  const table = await pool.query(
    `select to_regclass('drizzle.__drizzle_migrations') as t`,
  );
  if (table.rows[0]?.t == null) return 0;
  const { rows } = await pool.query(
    `select max(created_at) as latest from drizzle.__drizzle_migrations`,
  );
  return Number(rows[0]?.latest ?? 0);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set: pass the direct connection string in the environment",
    );
  }

  const journal = await readJournal();
  const pool = new Pool({ connectionString: url, max: 1 });
  pool.on("error", (error: Error) => {
    console.error(`database pool error: ${error.message}`);
  });
  try {
    const before = await latestApplied(pool);
    await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS });
    const after = await latestApplied(pool);

    const expected = Math.max(...journal.map((m) => m.when));
    if (after !== expected) {
      throw new Error(
        `migration check failed: the latest applied migration does not match the journal (${after} vs ${expected})`,
      );
    }
    const applied = journal.filter((m) => m.when > before);
    if (applied.length === 0) {
      console.log(
        `up to date: all ${journal.length} migrations were already applied`,
      );
    } else {
      console.log(
        `applied ${applied.length} of ${journal.length} migrations:\n${applied.map((m) => `  ${m.tag}`).join("\n")}`,
      );
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
