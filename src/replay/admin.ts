import { and, eq, sql } from "drizzle-orm";
import { reviewItems } from "@/db/schema";
import type { Db } from "@/db/types";
import { openReviewItem } from "@/reference/review";

/**
 * What an admin does during the replay (HLD §12, scripted scenarios): the
 * database-side counterpart of `Injection`, which acts on the providers. Times
 * are ISO 8601 instants with an offset.
 *
 * - `block`: opens a blocking review item on the event's `session` (a steward
 *   query, say). The session goes `under_review` the next time its status is
 *   advanced.
 * - `resolve`: resolves every item `block` opened for that session, and does
 *   nothing else. It does not advance the status (the M8 resolve action will;
 *   the replay leaves that to the finalize checks, which is what they are for).
 */
export type AdminAction =
  | { at: string; kind: "block"; session: string }
  | { at: string; kind: "resolve"; session: string };

const dedupeKey = (sessionId: string) => `replay:block:${sessionId}`;

/** Does `action` to the session (`sessionId` of `eventId`, in `seasonId`) at `now`. */
export async function applyAdminAction(
  db: Db,
  now: Date,
  target: { seasonId: string; eventId: string; sessionId: string },
  action: AdminAction,
): Promise<void> {
  if (action.kind === "block") {
    await openReviewItem(db, now, {
      kind: "validation_failed",
      severity: "blocking",
      seasonId: target.seasonId,
      eventId: target.eventId,
      sessionId: target.sessionId,
      details: { problem: "replay: a steward query holds the session" },
      dedupeKey: dedupeKey(target.sessionId),
    });
    return;
  }
  await db
    .update(reviewItems)
    .set({
      status: "resolved",
      resolution: "replay: an admin resolved it",
      resolvedAt: now,
      version: sql`${reviewItems.version} + 1`,
    })
    .where(
      and(
        eq(reviewItems.dedupeKey, dedupeKey(target.sessionId)),
        eq(reviewItems.status, "open"),
      ),
    );
}
