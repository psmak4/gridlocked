/**
 * Spike, local runs only (ledger R1): an in-memory PGlite with the app's
 * migrations, the recorded 2026 season and the spike tables, so no Neon
 * connection string is ever needed on this machine. Paths come from the
 * working directory because the production build moves this file.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { ltree } from "@electric-sql/pglite/contrib/ltree";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { Db } from "@/db/types";
import { resolveClock } from "@/lib/resolve-clock";
// eslint-disable-next-line no-restricted-imports -- spike: local seed only
import { importSeason2026 } from "@/providers/import/import-season";

export async function localDb(): Promise<Db> {
  const root = process.cwd();
  const client = new PGlite({ extensions: { btree_gist, ltree } });
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: path.join(root, "src/db/migrations") });
  const clock = await resolveClock({ mode: "system", db });
  await importSeason2026(db, clock, path.join(root, "tests/fixtures"));
  await db.execute(sql`create table spike_picks (user_id text not null,
    round int not null, driver_id text not null, primary key (user_id, round))`);
  await db.execute(sql`create table spike_hits (path text not null,
    at timestamptz not null default clock_timestamp())`);
  // Better Auth's tables (generated SQL, src/spike/auth.sql).
  const authSql = await readFile(path.join(root, "src/spike/auth.sql"), "utf8");
  for (const statement of authSql.split("--> statement-breakpoint")) {
    if (statement.trim()) await db.execute(sql.raw(statement));
  }
  return db as unknown as Db;
}
