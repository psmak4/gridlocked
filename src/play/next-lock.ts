import { and, gte, min, ne } from "drizzle-orm";
import { events } from "@/db/schema";
import type { Db } from "@/db/types";

/**
 * The first lock at or after `now`, of an event that isn't cancelled, or null
 * after the last. The public cache shortens its stale window near it (M9
 * Task 6).
 */
export async function nextLockAt(db: Db, now: Date): Promise<Date | null> {
  const [row] = await db
    .select({ lockAt: min(events.lockAt) })
    .from(events)
    .where(and(gte(events.lockAt, now), ne(events.status, "cancelled")));
  return row?.lockAt ?? null;
}
