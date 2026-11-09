/**
 * Row-lock order for one user's rows (Ruling 59): the `users` row, then the
 * `profiles` row, as the deletion scrub takes them. A path that locked the
 * profile first and then inserted a row pointing at the user (which takes KEY
 * SHARE on `users`) could deadlock against a scrub holding `users` FOR UPDATE
 * and waiting for the profile. Locking `users` first makes such a path wait
 * for the scrub, or the scrub for it, but never both.
 */
import { eq } from "drizzle-orm";
import { users } from "@/db/schema";
import type { Db } from "@/db/types";

/**
 * Locks the user's row FOR NO KEY UPDATE (it isn't deleted or re-keyed by the
 * caller). True when the row exists. Call it before locking or updating their
 * profile.
 */
export async function lockUserRow(tx: Db, userId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .for("no key update");
  return row !== undefined;
}
