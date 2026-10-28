import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asc } from "drizzle-orm";
import { createTestDb } from "../../../tests/helpers/test-db";
import { providerRequests, rawSnapshots } from "@/db/schema";
import { simulatedClock } from "@/lib/clock";
import { createProviderClient } from "./client";
import { createRateLimiter } from "./rate-limiter";

const start = new Date("2026-03-08T10:00:00.000Z");

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
    limits = { perSecond: 100 },
  ) {
    const clock = simulatedClock(start);
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
      clock.advance(ms);
    };
    const urls: string[] = [];
    const queue = [...responses];
    const fakeFetch = (async (input: string | URL | Request) => {
      urls.push(String(input));
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
      limiter: createRateLimiter(limits, clock, sleep),
      sleep,
    });
    return { client, clock, sleeps, urls };
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

  it("records the call duration from the clock", async () => {
    const clock = simulatedClock(start);
    const sleep = async (ms: number) => clock.advance(ms);
    const client = createProviderClient({
      provider: "openf1",
      baseUrl: "https://api.openf1.org/v1",
      db: t.db,
      clock,
      fetch: (async () => {
        clock.advance(250);
        return json([]);
      }) as typeof fetch,
      limiter: createRateLimiter({ perSecond: 10 }, clock, sleep),
      sleep,
    });
    await client.get("/sessions");
    const [req] = await requests();
    expect(req!.durationMs).toBe(250);
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
});
