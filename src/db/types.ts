import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import type * as schema from "./schema";

/**
 * Any Drizzle Postgres database or transaction over our schema: the Neon
 * driver in production, PGlite in tests. Domain code takes this, so it works
 * inside a transaction too.
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
