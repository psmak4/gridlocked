/**
 * The real database (Neon Postgres over WebSocket), for the scheduler tick and
 * the scripts. Tests use PGlite instead (tests/helpers/test-db.ts); both
 * satisfy `Db`.
 *
 * The WebSocket `Pool` driver, not the HTTP one: the job queue and the
 * results writes use interactive transactions, `FOR UPDATE`,
 * `SET CONSTRAINTS ALL DEFERRED` and savepoints, which neon-http cannot do.
 * Node 22 and later (the app and the Functions runtime are Node 24) have a
 * global `WebSocket`, so the driver needs no `ws` package.
 */
import { Pool } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-serverless";
import * as schema from "./schema";
import type { Db } from "./types";
import type { ClockDb } from "@/lib/resolve-clock";

export interface DbHandle {
  /**
   * The database. The first call opens the Pool, so code that may never need
   * the database (a sleeping tick) can hold a handle without waking Postgres.
   */
  db(): Db & ClockDb;
  /** Ends the Pool if one was opened. Safe to call twice. */
  close(): Promise<void>;
}

/** A tick runs jobs one at a time; a few connections cover a transaction plus its logging. */
const MAX_CONNECTIONS = 4;

export function createDb(url: string): DbHandle {
  let pool: Pool | undefined;
  let db: (Db & ClockDb) | undefined;

  return {
    db() {
      if (!db) {
        pool = new Pool({ connectionString: url, max: MAX_CONNECTIONS });
        // An idle client that the server drops emits "error" on the Pool. With
        // no listener Node would throw it and end the process; the next query
        // simply gets a fresh connection instead.
        pool.on("error", (error: Error) => {
          console.error(`database pool error: ${error.message}`);
        });
        db = drizzle(pool, { schema });
      }
      return db;
    },
    async close() {
      const open = pool;
      pool = undefined;
      db = undefined;
      await open?.end();
    },
  };
}
