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

// One migrated template database per Vitest worker (module state is
// per-worker), built lazily on first use. Booting + migrating is the slow part;
// cloning it is cheap. It lives for the worker's lifetime and is never closed.
let template: Promise<PGlite> | undefined;

function getTemplate(): Promise<PGlite> {
  template ??= (async () => {
    const client = new PGlite({ extensions: { btree_gist, ltree } });
    await migrate(drizzle(client, { schema }), { migrationsFolder });
    return client;
  })();
  return template;
}

/**
 * A fresh, fully migrated in-memory Postgres, cloned from the per-worker
 * template. The btree_gist and ltree extensions are loaded (available to
 * `create extension`), not created. Callers must `close()` it.
 */
export async function createTestDb(): Promise<{
  db: PgliteDatabase<typeof schema>;
  client: PGlite;
  close(): Promise<void>;
}> {
  // clone() is typed as PGliteInterface but returns a PGlite instance.
  const client = (await (await getTemplate()).clone()) as PGlite;
  const db = drizzle(client, { schema });
  return { db, client, close: () => client.close() };
}
