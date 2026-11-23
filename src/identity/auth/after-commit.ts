/**
 * `identity_after_commit` from Better Auth's side (M9 Task 2): the job is
 * written in Better Auth's transaction when there is one, and run once it
 * commits. The work itself is in `../after-commit.ts`, apart from Better Auth,
 * so the tick can run it too.
 */
import { queueAfterTransactionHook } from "@better-auth/core/context";
import type { Db } from "@/db/types";
import {
  keepAfterCommit,
  runAfterCommit,
  type AfterCommitWork,
} from "../after-commit";

/** A class name, never a message: a database error's carries the parameters. */
function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

/**
 * Keeps `work`: writes its job on `tx` (Better Auth's open transaction) or on
 * `db`, then runs it once the transaction commits (at once, outside one). A
 * failure of that run is logged by event and error name; the job retries it.
 */
export async function afterAuthCommit(
  db: Db,
  now: Date,
  work: AfterCommitWork,
  tx?: Db,
): Promise<void> {
  const id = await keepAfterCommit(tx ?? db, now, work);
  await queueAfterTransactionHook(
    async () => {
      await runAfterCommit(db, id, "inline", now);
    },
    {
      onError: (error) => {
        console.error(
          `identity after-commit ${work.event} failed: ${errorName(error)}; its job retries it`,
        );
      },
    },
  );
}
