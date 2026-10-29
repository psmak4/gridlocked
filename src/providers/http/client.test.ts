import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asc } from "drizzle-orm";
import { createTestDb } from "../../../tests/helpers/test-db";
import {
  circuits,
  events,
  jobs,
  providerRequests,
  rawSnapshots,
  seasons,
  sessions,
} from "@/db/schema";
import { newId } from "@/lib/ids";
import { fixedClock, simulatedClock, type Timer } from "@/lib/clock";
import { createProviderClient } from "./client";
import { ProviderUnavailableError } from "@/jobs/ports";
import { createRateLimiter } from "./rate-limiter";

const start = new Date("2026-03-08T10:00:00.000Z");

/** A timer that reads a simulated clock; `sleep` advances it. */
const timerOn = (
  clock: ReturnType<typeof simulatedClock>,
  sleeps: number[] = [],
): Timer => ({
  now: () => clock.now().getTime(),
  sleep: async (ms) => {
    sleeps.push(ms);
    clock.advance(ms);
  },
});

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("createProviderClient", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    t = await createTestDb();
  });

  afterEach(async () => {
    await t.close();
  });

  function setup(
    responses: Array<Response | Error | (() => Response)>,
    limits: { perSecond: number } = { perSecond: 100 },
    extra: { timeoutMs?: number; deadlineAt?: number } = {},
  ) {
    const clock = simulatedClock(start);
    const sleeps: number[] = [];
    const timer = timerOn(clock, sleeps);
    const urls: string[] = [];
    const inits: Array<RequestInit | undefined> = [];
    const queue = [...responses];
    const fakeFetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      urls.push(String(input));
      inits.push(init);
      const next = queue.shift();
      if (next === undefined)
        throw new Error("fake fetch ran out of responses");
      if (next instanceof Error) throw next;
      return typeof next === "function" ? next() : next;
    }) as typeof fetch;
    const client = createProviderClient({
      provider: "jolpica",
      baseUrl: "https://api.jolpi.ca/ergast/f1",
      db: t.db,
      clock,
      fetch: fakeFetch,
      limiter: createRateLimiter(limits, timer),
      timer,
      ...extra,
    });
    return { client, clock, sleeps, urls, inits };
  }

  const requests = () =>
    t.db.select().from(providerRequests).orderBy(asc(providerRequests.id));

  it("builds the URL from base, endpoint and params, and stores the snapshot", async () => {
    const { client, urls } = setup([json({ ok: true })]);
    const out = await client.get("/2026/1/results.json", { limit: "100" });

    expect(urls).toEqual([
      "https://api.jolpi.ca/ergast/f1/2026/1/results.json?limit=100",
    ]);
    expect(out.body).toEqual({ ok: true });
    expect(out.changed).toBe(true);

    const [req] = await requests();
    expect(req).toMatchObject({
      provider: "jolpica",
      endpoint: "/2026/1/results.json",
      params: { limit: "100" },
      statusCode: 200,
      outcome: "new_snapshot",
      snapshotId: out.snapshotId,
      error: null,
      jobId: null,
    });
    expect(req!.requestedAt).toEqual(start);
    const snaps = await t.db.select().from(rawSnapshots);
    expect(snaps.map((s) => s.id)).toEqual([out.snapshotId]);
  });

  it("logs an identical second response as unchanged and links the same snapshot", async () => {
    const { client } = setup([json({ a: 1, b: 2 }), json({ b: 2, a: 1 })]);
    const one = await client.get("/x");
    const two = await client.get("/x");

    expect(two.snapshotId).toBe(one.snapshotId);
    expect(two.changed).toBe(false);
    const rows = await requests();
    expect(rows.map((r) => r.outcome).sort()).toEqual([
      "new_snapshot",
      "unchanged",
    ]);
    expect(rows.every((r) => r.snapshotId === one.snapshotId)).toBe(true);
    expect(await t.db.select().from(rawSnapshots)).toHaveLength(1);
  });

  it("records the call duration from the timer", async () => {
    const clock = simulatedClock(start);
    const timer = timerOn(clock);
    const client = createProviderClient({
      provider: "openf1",
      baseUrl: "https://api.openf1.org/v1",
      db: t.db,
      clock,
      fetch: (async () => {
        clock.advance(250);
        return json([]);
      }) as typeof fetch,
      limiter: createRateLimiter({ perSecond: 10 }, timer),
      timer,
    });
    await client.get("/sessions");
    const [req] = await requests();
    expect(req!.durationMs).toBe(250);
  });

  it("stamps requested_at from the timer (when the limiter recorded the call) and the snapshot from the clock", async () => {
    // System mode: the clock is the tick's scheduled instant, fixed for the
    // whole tick, and only the timer sees time pass. The request log is rate
    // accounting, so it carries real time; domain time stays on the clock.
    const clock = fixedClock(start);
    const real = simulatedClock(new Date("2026-03-08T10:00:20.000Z"));
    const timer = timerOn(real);
    const client = createProviderClient({
      provider: "openf1",
      baseUrl: "https://api.openf1.org/v1",
      db: t.db,
      clock,
      fetch: (async () => {
        real.advance(250);
        return json([]);
      }) as typeof fetch,
      limiter: createRateLimiter({ perSecond: 10 }, timer),
      timer,
    });
    await client.get("/sessions");
    const [req] = await requests();
    expect(req!.requestedAt).toEqual(new Date("2026-03-08T10:00:20.000Z"));
    expect(req!.durationMs).toBe(250);
    const [snap] = await t.db.select().from(rawSnapshots);
    expect(snap!.firstFetchedAt).toEqual(start);
  });

  it("works out an HTTP-date Retry-After from the timer's now", async () => {
    // The clock is frozen at the tick's scheduled minute; the timer is 20 s later.
    const clock = fixedClock(start);
    const real = simulatedClock(new Date("2026-03-08T10:00:20.000Z"));
    const sleeps: number[] = [];
    const timer = timerOn(real, sleeps);
    const responses = [
      new Response("", {
        status: 429,
        headers: { "retry-after": "Sun, 08 Mar 2026 10:00:50 GMT" },
      }),
      json({ ok: 1 }),
    ];
    const client = createProviderClient({
      provider: "jolpica",
      baseUrl: "https://api.jolpi.ca/ergast/f1",
      db: t.db,
      clock,
      fetch: (async () => responses.shift()!) as typeof fetch,
      limiter: createRateLimiter({ perSecond: 10 }, timer),
      timer,
    });
    await client.get("/x");
    expect(sleeps).toEqual([30_000]);
  });

  it("waits Retry-After on a 429, then succeeds: two request rows, one snapshot", async () => {
    const { client, sleeps } = setup([
      new Response("slow down", {
        status: 429,
        headers: { "retry-after": "2" },
      }),
      json({ ok: 1 }),
    ]);
    const out = await client.get("/2026/1/results.json");

    expect(sleeps).toContain(2000);
    const rows = await requests();
    expect(rows).toHaveLength(2);
    const byOutcome = Object.fromEntries(rows.map((r) => [r.outcome, r]));
    expect(byOutcome["rate_limited"]).toMatchObject({
      statusCode: 429,
      snapshotId: null,
    });
    expect(byOutcome["new_snapshot"]).toMatchObject({
      statusCode: 200,
      snapshotId: out.snapshotId,
    });
    expect(await t.db.select().from(rawSnapshots)).toHaveLength(1);
  });

  it("waits 30 s on a 429 with no usable Retry-After", async () => {
    const { client, sleeps } = setup([
      new Response("", { status: 429 }),
      new Response("", { status: 429, headers: { "retry-after": "soon" } }),
      json({ ok: 1 }),
    ]);
    await client.get("/x");
    expect(sleeps).toEqual([30_000, 30_000]);
  });

  it("gives up after 3 retries of a 429 and throws, logging every attempt", async () => {
    const tooMany = () => new Response("", { status: 429 });
    const { client } = setup([tooMany, tooMany, tooMany, tooMany, tooMany]);
    await expect(client.get("/x")).rejects.toThrow(/429/);

    const rows = await requests();
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.outcome === "rate_limited")).toBe(true);
    expect(await t.db.select().from(rawSnapshots)).toHaveLength(0);
  });

  it("logs a network error with a null status and rethrows it", async () => {
    const { client } = setup([new TypeError("fetch failed")]);
    await expect(client.get("/x")).rejects.toThrow("fetch failed");

    const rows = await requests();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: "error",
      statusCode: null,
      snapshotId: null,
      error: "fetch failed",
    });
  });

  it("logs a non-2xx, non-429 response as an error and throws without retrying", async () => {
    const { client, urls } = setup([new Response("boom", { status: 503 })]);
    await expect(client.get("/x")).rejects.toThrow(/503/);
    expect(urls).toHaveLength(1);
    const [row] = await requests();
    expect(row).toMatchObject({ outcome: "error", statusCode: 503 });
    expect(row!.error).toMatch(/503/);
  });

  it("logs a non-JSON 200 as an error and throws, storing nothing", async () => {
    const { client } = setup([
      new Response("<html>oops</html>", { status: 200 }),
    ]);
    await expect(client.get("/x")).rejects.toThrow(/JSON/i);
    const [row] = await requests();
    expect(row).toMatchObject({
      outcome: "error",
      statusCode: 200,
      snapshotId: null,
    });
    expect(await t.db.select().from(rawSnapshots)).toHaveLength(0);
  });

  it("queues a backlog under the limiter and still logs every call", async () => {
    const bodies = Array.from({ length: 10 }, (_, i) => json({ i }));
    const { client, clock } = setup(bodies, { perSecond: 3 });
    await Promise.all(Array.from({ length: 10 }, () => client.get("/x")));

    expect(clock.now().getTime() - start.getTime()).toBeGreaterThanOrEqual(
      3000,
    );
    expect(await requests()).toHaveLength(10);
  });
  it("caps Retry-After at 30 s: a longer wait fails fast as ProviderUnavailableError, not slept", async () => {
    const { client, sleeps, urls } = setup([
      new Response("", { status: 429, headers: { "retry-after": "60" } }),
    ]);
    const error = await client.get("/x").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect((error as Error).message).toContain("retry-after too long: 60s");
    expect(sleeps).toEqual([]);
    expect(urls).toHaveLength(1);
    const rows = await requests();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: "rate_limited", statusCode: 429 });
  });

  it("still waits a Retry-After of exactly 30 s", async () => {
    const { client, sleeps } = setup([
      new Response("", { status: 429, headers: { "retry-after": "30" } }),
      json({ ok: 1 }),
    ]);
    await client.get("/x");
    expect(sleeps).toEqual([30_000]);
  });

  describe("with a deadline for the wake", () => {
    const at = (ms: number) => start.getTime() + ms;

    it("fails fast as ProviderUnavailableError when a limiter wait would end after it, sending nothing", async () => {
      const { client, urls, sleeps } = setup(
        [json({ a: 1 }), json({ a: 2 })],
        { perSecond: 1 },
        { deadlineAt: at(500) },
      );
      await client.get("/x"); // takes the one slot this second
      const error = await client.get("/y").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderUnavailableError);
      expect(urls).toHaveLength(1);
      expect(sleeps).toEqual([]);
      // The refused call is not logged: nothing was sent.
      expect(await requests()).toHaveLength(1);
    });

    it("waits for a limiter slot that ends inside the budget", async () => {
      const { client, sleeps } = setup(
        [json({ a: 1 }), json({ a: 2 })],
        { perSecond: 1 },
        { deadlineAt: at(5_000) },
      );
      await client.get("/x");
      await client.get("/y");
      expect(sleeps).toEqual([1000]);
    });

    it("fails fast when a Retry-After would end after it", async () => {
      const { client, sleeps, urls } = setup(
        [new Response("", { status: 429, headers: { "retry-after": "10" } })],
        undefined,
        { deadlineAt: at(5_000) },
      );
      const error = await client.get("/x").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderUnavailableError);
      expect(sleeps).toEqual([]);
      expect(urls).toHaveLength(1);
    });

    it("waits a Retry-After that fits in the budget", async () => {
      const { client, sleeps } = setup(
        [
          new Response("", { status: 429, headers: { "retry-after": "2" } }),
          json({ ok: 1 }),
        ],
        undefined,
        { deadlineAt: at(5_000) },
      );
      await client.get("/x");
      expect(sleeps).toEqual([2000]);
    });

    it("does not start a call once the deadline has passed", async () => {
      const { client, urls } = setup([json({ ok: 1 })], undefined, {
        deadlineAt: at(0),
      });
      await expect(client.get("/x")).rejects.toBeInstanceOf(
        ProviderUnavailableError,
      );
      expect(urls).toHaveLength(0);
    });
  });

  it("passes an abort signal to fetch for the timeout", async () => {
    const { client, inits } = setup([json({ ok: 1 })], undefined, {
      timeoutMs: 5_000,
    });
    await client.get("/x");
    expect(inits[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("logs a fetch timeout as an error with a null status and rethrows", async () => {
    const timeout = new DOMException(
      "The operation timed out.",
      "TimeoutError",
    );
    const { client } = setup([timeout as unknown as Error]);
    await expect(client.get("/x")).rejects.toBe(timeout);

    const rows = await requests();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: "error",
      statusCode: null,
      snapshotId: null,
    });
    expect(rows[0]!.error).toMatch(/timed out/);
  });

  it("measures duration right after the body is read, before storing the snapshot", async () => {
    // Every timer read moves time by 100 ms, so any extra read shows up.
    let time = start.getTime();
    const timer: Timer = {
      now: () => {
        const at = time;
        time += 100;
        return at;
      },
      sleep: async () => {},
    };
    const client = createProviderClient({
      provider: "jolpica",
      baseUrl: "https://api.jolpi.ca/ergast/f1",
      db: t.db,
      clock: fixedClock(start),
      fetch: (async () => json({ ok: 1 })) as typeof fetch,
      limiter: { acquire: async () => start.getTime() },
      timer,
    });
    await client.get("/x");
    const [row] = await requests();
    expect(row!.durationMs).toBe(100);
  });

  it("clamps a negative duration to zero", async () => {
    // The first read is the start; every later read is five seconds earlier.
    let reads = 0;
    const timer: Timer = {
      now: () => start.getTime() - (reads++ === 0 ? 0 : 5_000),
      sleep: async () => {},
    };
    const client = createProviderClient({
      provider: "jolpica",
      baseUrl: "https://api.jolpi.ca/ergast/f1",
      db: t.db,
      clock: fixedClock(start),
      fetch: (async () => json({ ok: 1 })) as typeof fetch,
      limiter: { acquire: async () => start.getTime() },
      timer,
    });
    await client.get("/x");
    const [row] = await requests();
    expect(row!.durationMs).toBe(0);
  });

  it("makes a 429 attempt use a limiter slot, so the retry waits for the window too", async () => {
    // Retry-After 0 means the retry has no wait of its own; at one call per
    // second it must still wait out the window the 429 attempt used.
    const { client, sleeps, clock } = setup(
      [
        new Response("", { status: 429, headers: { "retry-after": "0" } }),
        json({ ok: 1 }),
      ],
      { perSecond: 1 },
    );
    await client.get("/x");
    expect(sleeps).toEqual([0, 1000]);
    expect(clock.now().getTime() - start.getTime()).toBe(1000);
  });

  it("waits for Retry-After and the window together, whichever is longer", async () => {
    const { client, clock } = setup(
      [
        new Response("", { status: 429, headers: { "retry-after": "2" } }),
        json({ ok: 1 }),
      ],
      { perSecond: 1 },
    );
    await client.get("/x");
    expect(clock.now().getTime() - start.getTime()).toBe(2000);
  });

  it("records the job, season, event and session on the request and the snapshot", async () => {
    const seasonId = newId();
    await t.db
      .insert(seasons)
      .values({ id: seasonId, year: 2026, status: "active" });
    const circuitId = newId();
    await t.db.insert(circuits).values({
      id: circuitId,
      slug: "monaco",
      name: "Circuit de Monaco",
      locality: "Monte-Carlo",
      country: "Monaco",
      latitude: "43.734700",
      longitude: "7.420560",
      timezone: "Europe/Monaco",
    });
    const eventId = newId();
    await t.db.insert(events).values({
      id: eventId,
      seasonId,
      round: 1,
      slug: "2026-monaco",
      name: "Monaco Grand Prix",
      circuitId,
      format: "standard",
      status: "scheduled",
      lockAt: start,
      lockAtSource: "default",
    });
    const sessionId = newId();
    await t.db.insert(sessions).values({
      id: sessionId,
      eventId,
      kind: "race",
      sequence: 1,
      scheduledStart: start,
      startConfirmed: true,
      scheduledEnd: new Date(start.getTime() + 3600_000),
      timeSource: "provider",
      status: "completed",
    });
    const jobId = newId();
    await t.db.insert(jobs).values({
      id: jobId,
      kind: "poll",
      dedupeKey: "k",
      runAt: start,
      maxAttempts: 3,
    });

    const { client } = setup([json({ ok: 1 })]);
    await client.get("/x", {}, { jobId, seasonId, eventId, sessionId });

    const [req] = await requests();
    expect(req!.jobId).toBe(jobId);
    const [snap] = await t.db.select().from(rawSnapshots);
    expect(snap).toMatchObject({ seasonId, eventId, sessionId });
  });
});
