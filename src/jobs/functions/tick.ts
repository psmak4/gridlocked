/**
 * The Neon Function entry point (HLD §4.5, M1 result): one function, `tick`,
 * with two triggers declared in neon.ts.
 *
 *   POST /        every minute: `tick` (reads the due-times file, wakes
 *                 Postgres and runs the due jobs only when something is due)
 *   POST /safety  every six hours: `safetyTick` (the backstop)
 *
 * It is the one place the jobs meet the providers and the real database
 * (HLD §3.3 rule 2 allows it: see eslint.config.mjs), so it only wires:
 * `createDb` (Neon injects DATABASE_URL), `createDueStoreFromEnv` (Neon
 * injects the AWS_* variables for Object Storage), the clock mode from
 * CLOCK_MODE, and `createPipelineClients` / `createPipelineHandlers` with the
 * real fetch and the real timer. Nothing is opened at import time, and a
 * sleeping tick never opens the database.
 *
 * Scheduled calls arrive without credentials. Neon strips client-set
 * `X-Neon-*` headers at the edge, so the presence of
 * `X-Neon-Trigger-Invocation-Id` proves the trigger system sent it; anything
 * else gets 403. The handler is idempotent: a redelivered or overlapping
 * occurrence finds its jobs already claimed or done.
 */
import { createDb } from "@/db/client";
import { systemTimer } from "@/lib/clock";
import { clockModeFromEnv } from "@/lib/resolve-clock";
import { createPipelineHandlers } from "@/providers/pipeline";
import { createPipelineClients } from "@/providers/pipeline/clients";
import { createDueStoreFromEnv } from "@/providers/storage/due-store";
import type { DueStore } from "../due-times";
import {
  DEFAULT_TICK_OPTIONS,
  safetyTick,
  tick,
  type TickDeps,
  type TickOptions,
  type TickResult,
} from "../tick";

/**
 * A tick runs at most 20 jobs. Handlers have no heartbeat, so everything a
 * tick claims has to finish inside the 5-minute lease or `reapExpired` will
 * hand the still-running jobs to the next tick. A job is a few provider calls
 * (the limiter lets at most 3 a second through, and a call times out after
 * 30 s) plus a transaction, which is a second or two when nothing is wrong,
 * so 20 jobs take under a minute and leave a 5x margin for slow provider
 * responses and a database waking from suspend. The M1 burst of 20 trivial
 * jobs took 246 ms. If more are due, the file still says "wake" after the
 * republish and the next minute's tick takes the rest.
 */
export const FUNCTION_TICK_OPTIONS: TickOptions = {
  ...DEFAULT_TICK_OPTIONS,
  maxJobs: 20,
};

export type TickHandlerDeps = Pick<
  TickDeps,
  "db" | "store" | "handlers" | "mode"
> & { options?: TickOptions };

/** The scheduled instant from a trigger call's body: `data.scheduled_at`. */
async function readScheduledAt(request: Request): Promise<Date | null> {
  try {
    const body = (await request.json()) as {
      data?: { scheduled_at?: unknown };
    };
    const value = body?.data?.scheduled_at;
    if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
      return null;
    }
    return new Date(value);
  } catch {
    return null;
  }
}

const orNone = (at: string | null) => at ?? "none";

function describeTick(at: string, result: TickResult, ms: string): string {
  switch (result.action) {
    case "sleep":
      return `tick ${at} sleep ${ms}`;
    case "skip":
      return `tick ${at} skip ${result.reason} ${ms}`;
    case "republished":
      return `tick ${at} republished ${result.reason} next_due_at=${orNone(result.file.next_due_at)} ${ms}`;
    case "wake": {
      const { ran, failed, lost } = result.run;
      return `tick ${at} wake ran=${ran} failed=${failed} lost=${lost} next_due_at=${orNone(result.file.next_due_at)} ${ms}`;
    }
  }
}

/**
 * The request handler. `deps` may be a function, called on the first request
 * that passes the header, route and body checks, so a bad request never
 * builds anything. `log` gets one line per result.
 */
export function createTickHandler(
  deps: TickHandlerDeps | (() => TickHandlerDeps),
  log: (line: string) => void = console.log,
) {
  let resolved: TickHandlerDeps | undefined;
  const resolve = () =>
    (resolved ??= typeof deps === "function" ? deps() : deps);

  return async function handle(request: Request): Promise<Response> {
    if (!request.headers.get("x-neon-trigger-invocation-id")) {
      return new Response("forbidden", { status: 403 });
    }
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || (path !== "/" && path !== "/safety")) {
      return new Response("not found", { status: 404 });
    }
    const scheduledAt = await readScheduledAt(request);
    if (!scheduledAt) {
      return new Response("missing data.scheduled_at", { status: 400 });
    }

    const at = scheduledAt.toISOString();
    const label = path === "/safety" ? "safety" : "tick";
    const started = performance.now();
    const ms = () => `${Math.round(performance.now() - started)}ms`;
    try {
      const wired = resolve();
      if (path === "/safety") {
        const file = await safetyTick(wired, scheduledAt);
        log(
          `safety ${at} published next_due_at=${orNone(file.next_due_at)} ${ms()}`,
        );
        return Response.json({ ok: true, file });
      }
      const result = await tick(
        { ...wired, log },
        scheduledAt,
        wired.options ?? FUNCTION_TICK_OPTIONS,
      );
      log(describeTick(at, result, ms()));
      return Response.json({ ok: true, result });
    } catch (error) {
      // One line, and no detail in the response: the caller is Neon's trigger
      // system, which retries, and the logs hold the cause.
      const detail = error instanceof Error ? error.message : String(error);
      log(`${label} ${at} error: ${detail.replace(/\s+/g, " ")} ${ms()}`);
      return new Response("internal error", { status: 500 });
    }
  };
}

/**
 * The production wiring from the function's environment. `store` is for tests;
 * production builds it from the AWS_* variables Neon injects.
 */
export function depsFromEnv(
  env: Record<string, string | undefined>,
  overrides: { store?: DueStore } = {},
): TickHandlerDeps {
  const url = env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set (Neon injects it into functions)");
  }
  const mode = clockModeFromEnv(env);
  const store = overrides.store ?? createDueStoreFromEnv(env);
  const database = createDb(url);
  return {
    db: () => database.db(),
    store,
    mode,
    handlers: async (db, clock) =>
      createPipelineHandlers(
        await createPipelineClients({
          db,
          clock,
          timer: systemTimer,
          fetch: (input, init) => fetch(input, init),
        }),
      ),
  };
}

const handle = createTickHandler(() => depsFromEnv(process.env));

/** A Neon Function is a module whose default export has a `fetch(request)`. */
const tickFunction = { fetch: handle };

export default tickFunction;
