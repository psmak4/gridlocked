import { providerRequests } from "@/db/schema";
import type { Db } from "@/db/types";
import type { Clock, Timer } from "@/lib/clock";
import { newId } from "@/lib/ids";
import type { RateLimiter } from "./rate-limiter";
import { storeSnapshot } from "../snapshots";

export type ProviderName = "jolpica" | "openf1";

/** A question for a provider: an endpoint and its query parameters. */
export interface ProviderRequest {
  endpoint: string;
  params: Record<string, string>;
}

export interface ProviderCallContext {
  jobId?: string;
  seasonId?: string;
  eventId?: string;
  sessionId?: string;
}

export interface ProviderResponse {
  snapshotId: string;
  body: unknown;
  /** True when this response was new content, not a repeat of a stored one. */
  changed: boolean;
}

export interface ProviderClientOptions {
  provider: ProviderName;
  baseUrl: string;
  db: Db;
  /** The app's "now", for the `requested_at` stamps only. */
  clock: Clock;
  /**
   * Real time, for how long a call took, `Retry-After` and waiting. Apart from
   * `clock` because a tick's clock is frozen at its scheduled minute. Give the
   * limiter the same timer.
   */
  timer: Timer;
  fetch: typeof fetch;
  limiter: RateLimiter;
  /** Abort a request that has not finished after this long. Default 30 s. */
  timeoutMs?: number;
}

/**
 * Errors thrown by the `fetch` call itself (or while reading its body): the
 * connection failed, timed out or was aborted. The error is rethrown as it
 * came, and marked here so callers can tell a provider that is unreachable
 * from a bug in building the request (e.g. a bad URL).
 */
const networkFailures = new WeakSet<object>();

export function isNetworkFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null
    ? networkFailures.has(error)
    : false;
}

/** A provider answered with a status we do not accept. */
export class ProviderHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

const MAX_RETRIES = 3;
const DEFAULT_RETRY_AFTER_MS = 30_000;
/** A longer `Retry-After` is not waited out: the call fails instead. */
const MAX_RETRY_AFTER_MS = 300_000;
const DEFAULT_TIMEOUT_MS = 30_000;

/** `Retry-After` is seconds or an HTTP date. Anything else gets the default. */
function retryAfterMs(header: string | null, nowMs: number): number {
  if (header !== null && /^\d+$/.test(header.trim())) {
    return Number(header.trim()) * 1000;
  }
  if (header !== null) {
    const at = Date.parse(header);
    if (!Number.isNaN(at)) return Math.max(0, at - nowMs);
  }
  return DEFAULT_RETRY_AFTER_MS;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The one way to call a provider (HLD §4.1). Every attempt waits for the rate
 * limiter, is logged to `provider_requests`, and a good response becomes a
 * snapshot. A 429 waits `Retry-After` (30 s if absent) and retries up to
 * three times; any other failure is logged and thrown.
 */
export function createProviderClient(opts: ProviderClientOptions) {
  const { provider, baseUrl, db, clock, limiter, timer } = opts;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function get(
    endpoint: string,
    params: Record<string, string> = {},
    ctx: ProviderCallContext = {},
  ): Promise<ProviderResponse> {
    const url = new URL(baseUrl + endpoint);
    // Sorted, so the same question always has the same URL and logged params.
    const normalized = Object.fromEntries(
      Object.entries(params).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    for (const [key, value] of Object.entries(normalized)) {
      url.searchParams.set(key, value);
    }

    for (let attempt = 0; ; attempt++) {
      await limiter.acquire();
      const requestedAt = clock.now();
      const startedMs = timer.now();

      // Set once the response (or the failure) is in, before any database work.
      let durationMs = 0;
      const elapsed = () => Math.max(0, timer.now() - startedMs);

      const log = (entry: {
        statusCode: number | null;
        outcome: "new_snapshot" | "unchanged" | "error" | "rate_limited";
        snapshotId?: string;
        error?: string;
      }) =>
        db.insert(providerRequests).values({
          id: newId(),
          provider,
          endpoint,
          params: normalized,
          requestedAt,
          statusCode: entry.statusCode,
          durationMs,
          outcome: entry.outcome,
          snapshotId: entry.snapshotId ?? null,
          error: entry.error ?? null,
          jobId: ctx.jobId ?? null,
        });

      let response: Response;
      let text: string;
      try {
        response = await opts.fetch(url, {
          headers: { accept: "application/json" },
          signal: AbortSignal.timeout(timeoutMs),
        });
        text = await response.text();
        durationMs = elapsed();
      } catch (error) {
        durationMs = elapsed();
        if (typeof error === "object" && error !== null) {
          networkFailures.add(error);
        }
        await log({
          statusCode: null,
          outcome: "error",
          error: errorMessage(error),
        });
        throw error;
      }

      if (response.status === 429) {
        await log({
          statusCode: 429,
          outcome: "rate_limited",
          error: "HTTP 429 Too Many Requests",
        });
        if (attempt >= MAX_RETRIES) {
          throw new ProviderHttpError(
            429,
            `${provider} ${endpoint}: HTTP 429 after ${MAX_RETRIES} retries`,
          );
        }
        const waitMs = retryAfterMs(
          response.headers.get("retry-after"),
          timer.now(),
        );
        if (waitMs > MAX_RETRY_AFTER_MS) {
          throw new ProviderHttpError(
            429,
            `${provider} ${endpoint}: retry-after too long: ${Math.ceil(waitMs / 1000)}s`,
          );
        }
        await timer.sleep(waitMs);
        continue;
      }

      if (!response.ok) {
        const message = `HTTP ${response.status} ${response.statusText}`.trim();
        await log({
          statusCode: response.status,
          outcome: "error",
          error: message,
        });
        throw new ProviderHttpError(
          response.status,
          `${provider} ${endpoint}: ${message}`,
        );
      }

      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        const message = "Response body is not valid JSON";
        await log({
          statusCode: response.status,
          outcome: "error",
          error: message,
        });
        throw new ProviderHttpError(
          response.status,
          `${provider} ${endpoint}: ${message}`,
        );
      }

      let stored: { id: string; changed: boolean };
      try {
        stored = await storeSnapshot(db, {
          provider,
          endpoint,
          params: normalized,
          body,
          now: clock.now(),
          seasonId: ctx.seasonId,
          eventId: ctx.eventId,
          sessionId: ctx.sessionId,
        });
      } catch (error) {
        await log({
          statusCode: response.status,
          outcome: "error",
          error: `Could not store snapshot: ${errorMessage(error)}`,
        });
        throw error;
      }

      await log({
        statusCode: response.status,
        outcome: stored.changed ? "new_snapshot" : "unchanged",
        snapshotId: stored.id,
      });
      return { snapshotId: stored.id, body, changed: stored.changed };
    }
  }

  return { get };
}

export type ProviderClient = ReturnType<typeof createProviderClient>;
