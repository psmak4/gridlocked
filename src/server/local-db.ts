/**
 * Local runs only (`VITE_LOCAL_DB=1`): an in-memory PGlite with the app's
 * migrations, so the e2e tests and `pnpm dev` need no connection string.
 * `db.ts` imports it dynamically behind that flag, so a deployed build never
 * contains it. The path comes from the working directory because the
 * production build moves this file.
 */
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { ltree } from "@electric-sql/pglite/contrib/ltree";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";
import type { ServerDb } from "./db";

export async function localDb(): Promise<ServerDb> {
  const client = new PGlite({ extensions: { btree_gist, ltree } });
  const db = drizzle(client, { schema });
  await migrate(db, {
    migrationsFolder: path.join(process.cwd(), "src/db/migrations"),
  });
  return db as unknown as ServerDb;
}
