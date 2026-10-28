import { eq } from "drizzle-orm";
import { seasons } from "@/db/schema";
import type { ParticipantsSource } from "@/jobs/ports";
import type { ProviderClient } from "../http/client";
import {
  linkOpenF1Sessions,
  openF1SessionKey,
  parseOpenF1Drivers,
  storeParticipants,
} from "../openf1/participants";

/**
 * The pipeline's practice-participants port over OpenF1 (HLD §8.2). Links our
 * session to OpenF1's through `provider_ids` on first use (one `sessions` call
 * for the season), then fetches `drivers` for its session key and stores them.
 */
export function createOpenF1ParticipantsSource(
  client: ProviderClient,
): ParticipantsSource {
  return {
    async refresh(db, now, session, jobId) {
      const ctx = {
        jobId,
        seasonId: session.seasonId,
        eventId: session.eventId,
        sessionId: session.id,
      };
      let key = await openF1SessionKey(db, session.id);
      if (key === null) {
        const [season] = await db
          .select({ year: seasons.year })
          .from(seasons)
          .where(eq(seasons.id, session.seasonId));
        if (!season) throw new Error(`no season ${session.seasonId}`);
        const list = await client.get(
          "/sessions",
          { year: String(season.year) },
          { jobId, seasonId: session.seasonId, eventId: session.eventId },
        );
        await linkOpenF1Sessions(db, now, list.body);
        key = await openF1SessionKey(db, session.id);
        if (key === null) {
          throw new Error(
            `OpenF1 has no ${session.kind} session matching ${session.id}`,
          );
        }
      }
      const drivers = await client.get(
        "/drivers",
        { session_key: String(key) },
        ctx,
      );
      await storeParticipants(
        db,
        now,
        session.id,
        drivers.snapshotId,
        parseOpenF1Drivers(drivers.body),
      );
    },
  };
}
