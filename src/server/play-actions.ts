/**
 * The work behind the fantasy server functions in `play.ts` (M6), testable
 * without the Start runtime, as `account-actions.ts` is for M5's. The refusal
 * helpers live in `@/play/refusal`, which ships to the browser.
 */
import { z } from "zod";
import type { Db } from "@/db/types";
import { requireWritable, type Viewer } from "@/identity/viewer";
import { markWatched } from "@/spoilers/reveal";

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
