/**
 * The database for a server function or route (HLD §11.4). A logged-out page
 * never calls this, so it never wakes Postgres.
 *
 * Deployed hosts get `DATABASE_URL`, and every request shares one handle.
 * With `VITE_LOCAL_DB=1` (a build for local runs and the e2e tests) it is an
 * in-memory PGlite instead; the flag is replaced at build time, so the
 * import below, and PGlite with it, is dropped from any other build.
 */
import { createDb, type DbHandle } from "@/db/client";
import type { Db } from "@/db/types";
import type { ClockDb } from "@/lib/resolve-clock";

/** The database, and what `resolveClock` needs of it. */
export type ServerDb = Db & ClockDb;

let shared: DbHandle | undefined;
let local: Promise<ServerDb> | undefined;

export async function withDb<T>(fn: (db: ServerDb) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL;
  if (url) {
    shared ??= createDb(url);
    return fn(shared.db());
  }
  if (import.meta.env.VITE_LOCAL_DB === "1") {
    local ??= import("./local-db").then((m) => m.localDb());
    let db: ServerDb;
    try {
      db = await local;
    } catch (error) {
      // A failed start isn't cached: the next call tries again.
      local = undefined;
      throw error;
    }
    return fn(db);
  }
  throw new Error("DATABASE_URL is not set");
}
