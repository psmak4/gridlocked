import { and, eq } from "drizzle-orm";
import { providerIds } from "@/db/schema";
import type { Db } from "@/db/types";
import type { ResultsSource } from "@/jobs/ports";
import type { ProviderClient } from "../http/client";
import { asOutage } from "./failures";
import { normalizeJolpicaSession } from "../jolpica/normalize-session";

/** Jolpica's endpoint for each session kind it serves results for. */
const ENDPOINTS: Partial<Record<string, string>> = {
  race: "results",
  sprint: "sprint",
  qualifying: "qualifying",
};

/** Jolpica's key for our event, `season/round` (written by the calendar sync). */
async function eventKey(db: Db, eventId: string): Promise<string> {
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
  if (!row) throw new Error(`event ${eventId} has no Jolpica key`);
  return row.key;
}

/**
 * The pipeline's results port over Jolpica (HLD §4.1). Sprint qualifying is
 * not served by Jolpica, so asking for it is an error: no poll job is planned
 * for it, and its results come from the sprint grid or a manual entry.
 */
export function createJolpicaResultsSource(
  client: ProviderClient,
): ResultsSource {
  return {
    async fetch(db, session, jobId) {
      const endpoint = ENDPOINTS[session.kind];
      if (endpoint === undefined) {
        throw new Error(`Jolpica has no results for a ${session.kind} session`);
      }
      const key = await eventKey(db, session.eventId);
      const res = await asOutage(`Jolpica ${key} ${endpoint}`, () =>
        client.get(
          `/${key}/${endpoint}.json`,
          { limit: "100" },
          {
            jobId,
            seasonId: session.seasonId,
            eventId: session.eventId,
            sessionId: session.id,
          },
        ),
      );
      return { snapshotId: res.snapshotId, body: res.body };
    },
    normalize(db, now, session, snapshotId, body) {
      return normalizeJolpicaSession(db, now, session.id, snapshotId, body);
    },
  };
}
