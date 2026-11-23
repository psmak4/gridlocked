/**
 * The chat load test (M7 Task 16, decision 6): readers refreshing one session
 * thread's chat the way the page does, to check the CDN serves the crowd
 * (HLD §11.2, decision 19). Each reader asks for
 * `/api/chat/<thread>?after=<window start>` once per window, at its own
 * offset inside the window, so the requests are staggered as real phones'
 * would be. It only reads: it sends no messages and no cookies.
 *
 *   CHAT_LOAD_URL=https://<staging host> CHAT_LOAD_THREAD=<thread id> \
 *   CHAT_LOAD_SECONDS=600 pnpm chat-load --readers=50
 *
 * Expected (Task 16 step 5): about one function invocation a window (the
 * first request, a MISS), and `x-vercel-cache: HIT` for everyone after it.
 * It prints the totals by cache status, and the windows that had more than
 * one non-HIT answer.
 */

type Answer = {
  window: number;
  status: number;
  cache: string;
  ms: number;
};

const env = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === "")
    throw new Error(`${name} is not set`);
  return value;
};

const base = new URL(env("CHAT_LOAD_URL"));
const thread = env("CHAT_LOAD_THREAD");
if (!/^[0-9a-f-]{36}$/.test(thread))
  throw new Error("CHAT_LOAD_THREAD is a thread id");
// `--readers=150` overrides CHAT_LOAD_READERS (M9 Task 12 runs 50 and 150).
const readersFlag = process.argv
  .find((a) => a.startsWith("--readers="))
  ?.slice("--readers=".length);
const readers = Number(readersFlag ?? env("CHAT_LOAD_READERS", "50"));
if (!Number.isInteger(readers) || readers < 1)
  throw new Error("--readers is a whole number");
const seconds = Number(env("CHAT_LOAD_SECONDS", "600"));
const windowMs = Number(env("CHAT_LOAD_WINDOW_SECONDS", "3")) * 1000;

// The load test runs against the real site's clock: wall time is the point.
// eslint-disable-next-line no-restricted-syntax
const wall = () => Date.now();
const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

const answers: Answer[] = [];

async function reader(index: number, until: number): Promise<void> {
  // Spread across the window, as phones that opened the page at different
  // moments would be.
  const offset = Math.floor((index / readers) * windowMs);
  while (true) {
    const now = wall();
    const start = Math.floor(now / windowMs) * windowMs;
    let at = start + offset;
    if (at < now) at += windowMs;
    if (at >= until) return;
    await sleep(at - now);
    const window = Math.floor(at / windowMs) * windowMs;
    const url = new URL(`/api/chat/${thread}`, base);
    url.searchParams.set("after", new Date(window).toISOString());
    const sent = wall();
    try {
      const response = await fetch(url, { redirect: "manual" });
      await response.arrayBuffer();
      answers.push({
        window,
        status: response.status,
        cache: response.headers.get("x-vercel-cache") ?? "none",
        ms: wall() - sent,
      });
    } catch {
      answers.push({ window, status: 0, cache: "error", ms: wall() - sent });
    }
  }
}

async function main() {
  const until = wall() + seconds * 1000;
  console.log(
    `chat-load: ${readers} readers, ${windowMs / 1000} s windows, ${seconds} s, ${base.origin}`,
  );
  await Promise.all(
    Array.from({ length: readers }, (_, i) => reader(i, until)),
  );

  const byCache = new Map<string, number>();
  const byStatus = new Map<number, number>();
  const perWindow = new Map<number, Answer[]>();
  for (const a of answers) {
    byCache.set(a.cache, (byCache.get(a.cache) ?? 0) + 1);
    byStatus.set(a.status, (byStatus.get(a.status) ?? 0) + 1);
    perWindow.set(a.window, [...(perWindow.get(a.window) ?? []), a]);
  }
  const notHit = (list: Answer[]) => list.filter((a) => a.cache !== "HIT");
  const busy = [...perWindow.entries()].filter(
    ([, list]) => notHit(list).length > 1,
  );
  const invocations = answers.filter((a) => a.cache !== "HIT").length;
  const latencies = answers.map((a) => a.ms).sort((x, y) => x - y);
  const pct = (p: number) =>
    latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))];

  console.log(`requests: ${answers.length} in ${perWindow.size} windows`);
  console.log(`status: ${JSON.stringify(Object.fromEntries(byStatus))}`);
  console.log(`x-vercel-cache: ${JSON.stringify(Object.fromEntries(byCache))}`);
  console.log(
    `non-HIT (at most this many function invocations): ${invocations}, ${(invocations / Math.max(1, perWindow.size)).toFixed(2)} a window`,
  );
  console.log(`windows with more than one non-HIT: ${busy.length}`);
  for (const [window, list] of busy.slice(0, 10)) {
    console.log(
      `  ${new Date(window).toISOString()}: ${notHit(list)
        .map((a) => a.cache)
        .join(", ")}`,
    );
  }
  console.log(
    `latency ms: p50 ${pct(0.5)}, p95 ${pct(0.95)}, max ${latencies.at(-1)}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
