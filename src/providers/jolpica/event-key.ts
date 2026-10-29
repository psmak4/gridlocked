import { and, eq } from "drizzle-orm";
import { providerIds } from "@/db/schema";
import type { Db } from "@/db/types";

/**
 * Jolpica's key for our event, `season/round` (written by the calendar sync),
 * or null when the event has none.
 */
export async function jolpicaEventKey(
  db: Db,
  eventId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ key: providerIds.providerKey })
    .from(providerIds)
    .where(
      and(
        eq(providerIds.provider, "jolpica"),
        eq(providerIds.entityType, "event"),
        eq(providerIds.entityId, eventId),
      ),
    );
  return row?.key ?? null;
}
