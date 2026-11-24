/**
 * The race-end load test (M9 Task 12): when a race ends, readers arrive at
 * the scores page over a ramp, then each refreshes it every interval. It
 * checks the CDN serves the crowd (HLD §11.4: a public page is cached for
 * logged-out visitors, M9 Task 6). It only reads: no cookies, no writes.
 *
 *   RACE_LOAD_URL=https://<staging host> pnpm race-end-load \
 *     --readers=500 --ramp=60 --interval=30 --seconds=600 [--path=/weekend]
 *
 * Each flag can also be an environment variable (RACE_LOAD_READERS, …).
 * Seconds throughout. It prints requests, status and `x-vercel-cache`
 * counts, the non-HIT count (at most that many function invocations) and
 * latency percentiles.
 */
import { pathToFileURL } from "node:url";

export type PlanOptions = {
  readers: number;
  rampMs: number;
  intervalMs: number;
  durationMs: number;
};

/** One request: which reader, and when, in ms from the start. */
export type Planned = { reader: number; at: number };

/**
 * Every request of the run, in time order: reader `i` first opens the page
 * at `i / readers` of the way through the ramp, then once every interval
 * until the run ends.
 */
export function requestPlan(options: PlanOptions): Planned[] {
  const plan: Planned[] = [];
  for (let reader = 0; reader < options.readers; reader += 1) {
    const first = Math.floor((reader / options.readers) * options.rampMs);
    for (let at = first; at < options.durationMs; at += options.intervalMs) {
      plan.push({ reader, at });
    }
  }
  return plan.sort((a, b) => a.at - b.at || a.reader - b.reader);
}

export type Answer = { at: number; status: number; cache: string; ms: number };

export type RunDeps = {
  url: URL;
  clock: { now: () => number; sleep: (ms: number) => Promise<void> };
  fetch: (url: URL, init: RequestInit) => Promise<Response>;
};

/**
 * Sends the plan: each request at its time, without waiting for the ones
 * before it to answer, as a crowd's phones would. Resolves when all have.
 */
export async function runPlan(
  plan: Planned[],
  deps: RunDeps,
): Promise<Answer[]> {
  const start = deps.clock.now();
  const pending: Promise<Answer>[] = [];
  for (const item of plan) {
    const wait = start + item.at - deps.clock.now();
    if (wait > 0) await deps.clock.sleep(wait);
    const sent = deps.clock.now();
    pending.push(
      deps
        .fetch(deps.url, { redirect: "manual" })
        .then(async (response) => {
          const ms = deps.clock.now() - sent;
          await response.arrayBuffer();
          return {
            at: item.at,
            status: response.status,
            cache: response.headers.get("x-vercel-cache") ?? "none",
            ms,
          };
        })
        .catch(() => ({
          at: item.at,
          status: 0,
          cache: "error",
          ms: deps.clock.now() - sent,
        })),
    );
  }
  return Promise.all(pending);
}

export type Report = {
  requests: number;
  status: Record<number, number>;
  cache: Record<string, number>;
  /** Answers that weren't a CDN HIT: at most this many function invocations. */
  notHit: number;
  latency: { p50: number; p95: number; max: number };
};

export function summarize(answers: Answer[]): Report {
  const status: Record<number, number> = {};
  const cache: Record<string, number> = {};
  for (const a of answers) {
    status[a.status] = (status[a.status] ?? 0) + 1;
    cache[a.cache] = (cache[a.cache] ?? 0) + 1;
  }
  const ms = answers.map((a) => a.ms).sort((x, y) => x - y);
  const pct = (p: number) =>
    ms[Math.min(ms.length - 1, Math.floor(p * ms.length))] ?? 0;
  return {
    requests: answers.length,
    status,
    cache,
    notHit: answers.filter((a) => a.cache !== "HIT").length,
    latency: { p50: pct(0.5), p95: pct(0.95), max: ms.at(-1) ?? 0 },
  };
}

/** `--name=value` from argv, else RACE_LOAD_<NAME>, else the fallback. */
function setting(argv: string[], name: string, fallback?: string): string {
  const flag = argv.find((a) => a.startsWith(`--${name}=`));
  const value =
    flag?.slice(name.length + 3) ??
    process.env[`RACE_LOAD_${name.toUpperCase()}`] ??
    fallback;
  if (value === undefined || value === "")
    throw new Error(`--${name} is not set`);
  return value;
}

async function main(argv: string[]): Promise<void> {
  const url = new URL(setting(argv, "path", "/weekend"), setting(argv, "url"));
  const readers = Number(setting(argv, "readers", "500"));
  const options: PlanOptions = {
    readers,
    rampMs: Number(setting(argv, "ramp", "60")) * 1000,
    intervalMs: Number(setting(argv, "interval", "30")) * 1000,
    durationMs: Number(setting(argv, "seconds", "600")) * 1000,
  };
  const plan = requestPlan(options);
  console.log(
    `race-end-load: ${readers} readers, ${plan.length} requests over ${options.durationMs / 1000} s, ${url.href}`,
  );
  const answers = await runPlan(plan, {
    url,
    clock: {
      // The load test runs against the real site's clock: wall time is the point.
      // eslint-disable-next-line no-restricted-syntax
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
    fetch: (u, init) => fetch(u, init),
  });
  const report = summarize(answers);
  console.log(`requests: ${report.requests}`);
  console.log(`status: ${JSON.stringify(report.status)}`);
  console.log(`x-vercel-cache: ${JSON.stringify(report.cache)}`);
  console.log(
    `non-HIT (at most this many function invocations): ${report.notHit}`,
  );
  console.log(
    `latency ms: p50 ${report.latency.p50}, p95 ${report.latency.p95}, max ${report.latency.max}`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
