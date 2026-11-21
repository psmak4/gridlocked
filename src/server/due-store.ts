/**
 * The due-times file's store for a staff action that moves a job earlier
 * (M8 Task 5: a lock set by hand, a calendar sync). A local build
 * (`VITE_LOCAL_DB=1`) keeps the file in memory. A deployed one writes the
 * bucket through the AWS_* variables when it has them; without them it has
 * no store, and a moved job waits for the tick's next wake, at most the
 * 6-hourly safety tick. That is safe for a lock: a lineup save checks
 * `lock_at` itself, and the lock job takes the last lineup saved before it.
 * The flag is replaced at build time.
 *
 * A file in src/server that wires a storage adapter (eslint.config.mjs).
 */
import type { DueStore } from "@/jobs/due-times";
import { createDueStoreFromEnv } from "@/providers/storage/due-store";

let cached: DueStore | null | undefined;

export async function webDueStore(): Promise<DueStore | null> {
  if (import.meta.env.VITE_LOCAL_DB === "1") {
    return import("./local-db").then((m) => m.localDueStore);
  }
  if (cached === undefined) {
    try {
      cached = createDueStoreFromEnv(process.env);
    } catch {
      console.warn("due-times store: no AWS_* variables, so none");
      cached = null;
    }
  }
  return cached;
}
