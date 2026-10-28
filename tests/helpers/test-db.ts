import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { ltree } from "@electric-sql/pglite/contrib/ltree";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import * as schema from "@/db/schema";

const migrationsFolder = fileURLToPath(
  new URL("../../src/db/migrations", import.meta.url),
);

/**
 * A fresh, fully migrated in-memory Postgres. The btree_gist and ltree
 * extensions are loaded (available to `create extension`), not created.
 * Callers must `close()` it.
 */
export async function createTestDb(): Promise<{
  db: PgliteDatabase<typeof schema>;
  client: PGlite;
  close(): Promise<void>;
}> {
  const client = new PGlite({ extensions: { btree_gist, ltree } });
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder });
  return { db, client, close: () => client.close() };
}
