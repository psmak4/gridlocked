/**
 * The server's and the tick's error reporter (M9 Task 10). Not the Sentry
 * Node SDK: it brings OpenTelemetry and patches modules, and the tick is a
 * Neon Function bundled by the Neon CLI. This sends one scrubbed event per
 * error straight to the DSN's envelope endpoint, and nothing else: no
 * tracing, no request data, no breadcrumbs.
 *
 * No DSN means no reporting (local runs, tests and CI). A send that fails is
 * swallowed, and waits at most two seconds, so reporting never makes a
 * failing request worse.
 */
import { systemClock } from "@/lib/clock";
import { envelopeFor, eventFromError } from "@/lib/report-error";

/** Reports one unexpected error; `route` says where (a server function or "tick"). */
export type ReportError = (error: unknown, route: string) => Promise<void>;

export type ServerReporterOptions = {
  dsn: string | undefined;
  release?: string;
  environment?: string;
  runtime?: string;
  now: () => Date;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export function createServerReporter(
  options: ServerReporterOptions,
): ReportError {
  const { dsn } = options;
  if (!dsn) return async () => {};
  const send = options.fetch ?? fetch;
  const key = (() => {
    try {
      return new URL(dsn).username;
    } catch {
      return "";
    }
  })();
  return async (error, route) => {
    try {
      const event = eventFromError(error, {
        route,
        now: options.now(),
        release: options.release,
        environment: options.environment,
        runtime: options.runtime,
      });
      const envelope = envelopeFor(event, dsn);
      if (!envelope) return;
      await send(envelope.url, {
        method: "POST",
        headers: {
          "content-type": "application/x-sentry-envelope",
          "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${key}, sentry_client=paddock-club/1`,
        },
        body: envelope.body,
        signal: AbortSignal.timeout(options.timeoutMs ?? 2_000),
      });
    } catch {
      // Nothing to add: the caller's log line already says what failed.
    }
  };
}

type Env = Record<string, string | undefined>;

/** The tick's reporter, from the variables `neon.ts` declares. */
export function reporterFromEnv(env: Env, now: () => Date): ReportError {
  return createServerReporter({
    dsn: env.SENTRY_DSN,
    release: env.SENTRY_RELEASE,
    environment: env.SENTRY_ENVIRONMENT,
    runtime: "neon-function",
    now,
  });
}

let website: ReportError | undefined;

/**
 * The website's reporter. Vite writes the build's DSN, release and
 * environment in at build time, the same values the browser's SDK gets, so
 * Vercel needs no variable of its own.
 */
export const reportServerError: ReportError = (error, route) => {
  website ??= createServerReporter({
    dsn: import.meta.env.VITE_SENTRY_DSN as string | undefined,
    release: import.meta.env.VITE_SENTRY_RELEASE as string | undefined,
    environment: import.meta.env.VITE_SENTRY_ENVIRONMENT as string | undefined,
    runtime: "vercel",
    now: () => systemClock.now(),
  });
  return website(error, route);
};
