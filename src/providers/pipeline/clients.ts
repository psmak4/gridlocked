import { and, asc, gt, lte } from "drizzle-orm";
import { providerRequests } from "@/db/schema";
import type { Db } from "@/db/types";
import type { Clock, Timer } from "@/lib/clock";
import { getSetting } from "@/settings";
import { createProviderClient, type ProviderName } from "../http/client";
import { createRateLimiter } from "../http/rate-limiter";
import type { PipelineDeps } from ".";

export const JOLPICA_BASE_URL = "https://api.jolpi.ca/ergast/f1";
export const OPENF1_BASE_URL = "https://api.openf1.org/v1";

const HOUR_MS = 3_600_000;

/**
 * Each provider's calls from the last hour, up to the timer's now, as epoch
 * milliseconds oldest first: the longest window any limit looks at. Every
 * attempt the client makes is logged to `provider_requests`, including failed
 * and rate-limited ones, and each used a limiter slot, so all of them count.
 */
export async function loadRecentCalls(
  db: Db,
  timer: Timer,
): Promise<Record<ProviderName, number[]>> {
  const now = timer.now();
  const rows = await db
    .select({
      provider: providerRequests.provider,
      requestedAt: providerRequests.requestedAt,
    })
    .from(providerRequests)
    .where(
      and(
        gt(providerRequests.requestedAt, new Date(now - HOUR_MS)),
        lte(providerRequests.requestedAt, new Date(now)),
      ),
    )
    .orderBy(asc(providerRequests.requestedAt));

  const calls: Record<ProviderName, number[]> = { jolpica: [], openf1: [] };
  for (const row of rows) {
    if (row.provider === "jolpica" || row.provider === "openf1") {
      calls[row.provider].push(row.requestedAt.getTime());
    }
  }
  return calls;
}

/**
 * Both provider clients for one wake of the tick, on its database and clock.
 * Their limits come from the `provider_limits` setting, and each limiter is
 * seeded from the recent `provider_requests` so overlapping invocations (a
 * slow tick still running when the next minute's starts) share the same hourly
 * and per-minute budget instead of each spending a full one.
 *
 * The seed is what had been logged when the tick woke. A call another
 * invocation has sent but not yet logged (the client logs after the response)
 * is not in it, and `requested_at` is stamped from the tick's clock, which is
 * its scheduled minute rather than the instant of the call, so the count can
 * lag by up to the length of a tick. The configured limits sit well under the
 * providers' published ones to leave room for that.
 */
export async function createPipelineClients(opts: {
  db: Db;
  clock: Clock;
  timer: Timer;
  fetch: typeof fetch;
}): Promise<PipelineDeps> {
  const { db, clock, timer } = opts;
  const limits = await getSetting(db, "provider_limits");
  const recent = await loadRecentCalls(db, timer);

  const client = (provider: ProviderName, baseUrl: string) =>
    createProviderClient({
      provider,
      baseUrl,
      db,
      clock,
      timer,
      fetch: opts.fetch,
      limiter: createRateLimiter(limits[provider], timer, {
        seed: recent[provider],
      }),
    });
  return {
    jolpica: client("jolpica", JOLPICA_BASE_URL),
    openf1: client("openf1", OPENF1_BASE_URL),
  };
}
