import { eq } from "drizzle-orm";
import { seasons } from "@/db/schema";
import {
  ProviderUnavailableError,
  type ParticipantsSource,
} from "@/jobs/ports";
import { asOutage } from "./failures";
import type { ProviderClient, ProviderRequest } from "../http/client";
import {
  linkOpenF1Sessions,
  openF1SessionKey,
  parseOpenF1Drivers,
  storeParticipants,
} from "../openf1/participants";

/** The season's session list, which links our sessions to OpenF1's. */
export const openF1SessionsRequest = (year: number): ProviderRequest => ({
  endpoint: "/sessions",
  params: { year: String(year) },
});

/** Who took part in one OpenF1 session. */
export const openF1DriversRequest = (sessionKey: number): ProviderRequest => ({
  endpoint: "/drivers",
  params: { session_key: String(sessionKey) },
});

/**
 * The pipeline's practice-participants port over OpenF1 (HLD §8.2). Links our
 * session to OpenF1's through `provider_ids` on first use (one `sessions` call
 * for the season), then fetches `drivers` for its session key and stores them.
 *
 * An outage, and a season list that has no session matching ours yet (OpenF1
 * publishes a session a little after it ends), both throw
 * `ProviderUnavailableError`: the roster job asks again later.
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
        const sessionsRequest = openF1SessionsRequest(season.year);
        const list = await asOutage("OpenF1 /sessions", () =>
          client.get(sessionsRequest.endpoint, sessionsRequest.params, {
            jobId,
            seasonId: session.seasonId,
            eventId: session.eventId,
          }),
        );
        await linkOpenF1Sessions(db, now, list.body);
        key = await openF1SessionKey(db, session.id);
        if (key === null) {
          throw new ProviderUnavailableError(
            `OpenF1 has no ${session.kind} session matching ${session.id} yet`,
          );
        }
      }
      const driversRequest = openF1DriversRequest(key);
      const drivers = await asOutage("OpenF1 /drivers", () =>
        client.get(driversRequest.endpoint, driversRequest.params, ctx),
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
