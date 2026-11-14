/**
 * The work behind the fantasy server functions in `play.ts` (M6), testable
 * without the Start runtime, as `account-actions.ts` is for M5's.
 */
import { z } from "zod";
import type { Db } from "@/db/types";
import { GameError, type GameErrorCode } from "@/game/errors";
import { requireWritable, type Viewer } from "@/identity/viewer";
import { markWatched } from "@/spoilers/reveal";

/** A refusal a screen can show, in wave 2's words. */
export type Refusal = { ok: false; error: GameErrorCode };

/** True for a refusal, so a loader can tell one from its answer. */
export function isRefusal(value: unknown): value is Refusal {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { ok?: unknown }).ok === false
  );
}

/**
 * Runs `fn`, turning a `GameError` into `{ ok: false, error }`. Anything else
 * is thrown on, for M5's middleware to send as `server_error`.
 */
export async function refusalOf<T>(fn: () => Promise<T>): Promise<T | Refusal> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof GameError) return { ok: false, error: error.code };
    throw error;
  }
}

/** The most sessions one "Mark as watched" may name (a weekend has at most 5). */
export const MAX_WATCH_MARKS = 10;

export const markSessionsWatchedInput = z.object({
  sessionIds: z.array(z.uuid()).min(1).max(MAX_WATCH_MARKS),
});

/** "Mark as watched" (DM 5.7): stored for the signed-in viewer. */
export async function markSessionsWatchedAction(
  db: Db,
  now: Date,
  viewer: Viewer | null,
  data: z.infer<typeof markSessionsWatchedInput>,
): Promise<{ ok: true }> {
  const v = requireWritable(viewer);
  await markWatched(db, now, { userId: v.userId, sessionIds: data.sessionIds });
  return { ok: true };
}
