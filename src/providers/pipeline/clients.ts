import { and, asc, gt, lte } from "drizzle-orm";
import { providerRequests } from "@/db/schema";
import type { Db } from "@/db/types";
import type { Clock, Timer } from "@/lib/clock";
import { getSetting } from "@/settings";
import { createProviderClient, type ProviderName } from "../http/client";
import {
  createRateLimiter,
  type RateLimits,
  type SeedableRateLimiter,
} from "../http/rate-limiter";
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

export type ProviderLimiters = Record<ProviderName, SeedableRateLimiter>;

export interface SharedLimiters {
  /**
   * The limiters for a wake: read `provider_limits` and the last hour of
   * `provider_requests`, merge the log into the limiters (keeping calls this
   * isolate has sent but not yet logged), and return them. The same objects
   * every time, unless the configured limits changed.
   */
  prepare(db: Db): Promise<ProviderLimiters>;
}

/**
 * One limiter per provider for the lifetime of an isolate (the Function's
 * warm process), created once and re-seeded at each wake. Cron invocations
 * that overlap in one isolate then share a single in-memory count, which
 * includes calls that are in flight and not yet in the request log, while
 * invocations in other isolates are seen through the log.
 */
export function createSharedLimiters(timer: Timer): SharedLimiters {
  const held = new Map<
    ProviderName,
    { limitsKey: string; limiter: SeedableRateLimiter }
  >();
  return {
    async prepare(db) {
      const limits = await getSetting(db, "provider_limits");
      const recent = await loadRecentCalls(db, timer);
      const limiterFor = (provider: ProviderName) => {
        const wanted: RateLimits = limits[provider];
        const key = JSON.stringify(wanted);
        const current = held.get(provider);
        if (current && current.limitsKey === key) {
          current.limiter.seed(recent[provider]);
          return current.limiter;
        }
        const limiter = createRateLimiter(wanted, timer, {
          seed: recent[provider],
        });
        held.set(provider, { limitsKey: key, limiter });
        return limiter;
      };
      return { jolpica: limiterFor("jolpica"), openf1: limiterFor("openf1") };
    },
  };
}

/**
 * Both provider clients for one wake of the tick, on its database and clock.
 * Their limits come from the `provider_limits` setting, and each limiter is
 * seeded from the recent `provider_requests` so overlapping invocations (a
 * slow tick still running when the next minute's starts) share the same hourly
 * and per-minute budget instead of each spending a full one. Pass `limiters`
 * (from `createSharedLimiters`) to keep one limiter per provider across wakes
 * in a long-lived process; without it each call builds its own.
 *
 * `requested_at` in the log is the timer's now when the limiter recorded the
 * call, so what a later wake reads back is real time, not the scheduled minute
 * of the tick that made the call. A call another invocation has sent but not
 * yet logged (the client logs after the response) is not in the seed.
 *
 * `deadlineAt` (the timer's epoch ms) is the wake's time budget: the clients
 * start nothing after it and never sleep past it (see `ProviderClientOptions`).
 */
export async function createPipelineClients(opts: {
  db: Db;
  clock: Clock;
  timer: Timer;
  fetch: typeof fetch;
  deadlineAt?: number;
  limiters?: SharedLimiters;
}): Promise<PipelineDeps> {
  const { db, clock, timer } = opts;
  const limiters = await (opts.limiters ?? createSharedLimiters(timer)).prepare(
    db,
  );

  const client = (provider: ProviderName, baseUrl: string) =>
    createProviderClient({
      provider,
      baseUrl,
      db,
      clock,
      timer,
      fetch: opts.fetch,
      limiter: limiters[provider],
      deadlineAt: opts.deadlineAt,
    });
  return {
    jolpica: client("jolpica", JOLPICA_BASE_URL),
    openf1: client("openf1", OPENF1_BASE_URL),
  };
}
