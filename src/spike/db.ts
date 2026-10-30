/**
 * Spike: the database for a server function or route. Deployed hosts get
 * `DATABASE_URL` (the `fw-spike` branch, set by the user on each host);
 * local runs use the seeded PGlite (ledger R1).
 *
 * On Cloudflare Workers a WebSocket can't outlive the request that opened
 * it, so there each call opens and closes its own Pool. Node hosts share one.
 */
import { createDb, type DbHandle } from "@/db/client";
import type { Db } from "@/db/types";

const onWorkers =
  typeof navigator !== "undefined" &&
  navigator.userAgent === "Cloudflare-Workers";

let shared: DbHandle | undefined;
let local: Promise<Db> | undefined;

export async function withDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    if (import.meta.env.VITE_SPIKE_LOCAL !== "1") {
      throw new Error("DATABASE_URL is not set");
    }
    local ??= import("./local-db").then((m) => m.localDb());
    return fn(await local);
  }
  if (onWorkers) {
    const handle = createDb(url);
    try {
      return await fn(handle.db());
    } finally {
      await handle.close();
    }
  }
  shared ??= createDb(url);
  return fn(shared.db());
}
