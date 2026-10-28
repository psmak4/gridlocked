import { reviewItems } from "@/db/schema";
import type { Db } from "@/db/types";
import { newId } from "@/lib/ids";

/**
 * Opens a warning in the admin queue. A second call with the same
 * `dedupeKey` while the first is still open does nothing. Returns true when
 * this call opened a new item.
 */
export async function openReviewItem(
  db: Db,
  now: Date,
  item: {
    kind: string;
    seasonId: string;
    eventId?: string | null;
    sessionId?: string | null;
    details: Record<string, unknown>;
    dedupeKey: string;
  },
): Promise<boolean> {
  const rows = await db
    .insert(reviewItems)
    .values({
      id: newId(),
      kind: item.kind,
      severity: "warning",
      seasonId: item.seasonId,
      eventId: item.eventId ?? null,
      sessionId: item.sessionId ?? null,
      details: item.details,
      dedupeKey: item.dedupeKey,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: reviewItems.id });
  return rows.length > 0;
}
