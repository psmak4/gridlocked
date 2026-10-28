import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import { rawSnapshots } from "@/db/schema";
import { canonicalJson, storeSnapshot } from "./snapshots";

describe("canonicalJson", () => {
  it("sorts keys at every level", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      '{"a":{"c":3,"d":2},"b":1}',
    );
  });

  it("keeps array order and sorts keys inside array items", () => {
    expect(canonicalJson([{ b: 1, a: 2 }, 3, null, "x"])).toBe(
      '[{"a":2,"b":1},3,null,"x"]',
    );
  });

  it("drops undefined object values, as JSON.stringify does", () => {
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });
});

describe("storeSnapshot", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    t = await createTestDb();
  });

  afterEach(async () => {
    await t.close();
  });

  const base = {
    provider: "jolpica",
    endpoint: "/2026/1/results",
    params: { limit: "100" },
  };

  it("stores a new body once and reports it as changed", async () => {
    const now = new Date("2026-03-08T10:00:00Z");
    const body = { MRData: { total: "1", RaceTable: { Races: [] } } };
    const result = await storeSnapshot(t.db, { ...base, body, now });

    expect(result.changed).toBe(true);
    const [row] = await t.db.select().from(rawSnapshots);
    expect(row!.id).toBe(result.id);
    expect(row!.body).toEqual(body);
    expect(row!.bodyBytes).toBe(Buffer.byteLength(canonicalJson(body), "utf8"));
    expect(row!.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.paramsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.firstFetchedAt).toEqual(now);
    expect(row!.lastSeenAt).toEqual(now);
  });

  it("measures body_bytes in UTF-8 bytes, not characters", async () => {
    const body = { name: "Pérez", flag: "🇲🇽" };
    await storeSnapshot(t.db, { ...base, body, now: new Date(0) });
    const [row] = await t.db.select().from(rawSnapshots);
    expect(row!.bodyBytes).toBe(Buffer.byteLength(canonicalJson(body), "utf8"));
    expect(row!.bodyBytes).toBeGreaterThan(canonicalJson(body).length);
  });

  it("stores the same body twice as one snapshot and moves last_seen_at", async () => {
    const first = new Date("2026-03-08T10:00:00Z");
    const second = new Date("2026-03-08T12:00:00Z");
    const body = { a: 1, b: [1, 2] };

    const one = await storeSnapshot(t.db, { ...base, body, now: first });
    const two = await storeSnapshot(t.db, { ...base, body, now: second });

    expect(one.changed).toBe(true);
    expect(two.changed).toBe(false);
    expect(two.id).toBe(one.id);
    const rows = await t.db.select().from(rawSnapshots);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.firstFetchedAt).toEqual(first);
    expect(rows[0]!.lastSeenAt).toEqual(second);
  });

  it("treats a body that differs only in key order as unchanged", async () => {
    const one = await storeSnapshot(t.db, {
      ...base,
      body: { a: 1, b: { c: 2, d: 3 } },
      now: new Date("2026-03-08T10:00:00Z"),
    });
    const two = await storeSnapshot(t.db, {
      ...base,
      body: { b: { d: 3, c: 2 }, a: 1 },
      now: new Date("2026-03-08T11:00:00Z"),
    });
    expect(two.changed).toBe(false);
    expect(two.id).toBe(one.id);
    expect(await t.db.select().from(rawSnapshots)).toHaveLength(1);
  });

  it("stores a different body for the same question as a new snapshot", async () => {
    const one = await storeSnapshot(t.db, {
      ...base,
      body: { v: 1 },
      now: new Date("2026-03-08T10:00:00Z"),
    });
    const two = await storeSnapshot(t.db, {
      ...base,
      body: { v: 2 },
      now: new Date("2026-03-08T11:00:00Z"),
    });
    expect(two.changed).toBe(true);
    expect(two.id).not.toBe(one.id);
    const rows = await t.db.select().from(rawSnapshots);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.paramsHash)).size).toBe(1);
  });

  it("hashes provider, endpoint and params into the question", async () => {
    const body = { same: true };
    const now = new Date(0);
    await storeSnapshot(t.db, { ...base, body, now });
    await storeSnapshot(t.db, {
      ...base,
      endpoint: "/2026/2/results",
      body,
      now,
    });
    await storeSnapshot(t.db, { ...base, params: { limit: "50" }, body, now });
    await storeSnapshot(t.db, { ...base, provider: "openf1", body, now });
    const rows = await t.db.select().from(rawSnapshots);
    expect(new Set(rows.map((r) => r.paramsHash)).size).toBe(4);
    expect(new Set(rows.map((r) => r.contentHash)).size).toBe(1);
  });

  it("ignores params key order when hashing the question", async () => {
    const body = { same: true };
    const now = new Date(0);
    const one = await storeSnapshot(t.db, {
      ...base,
      params: { a: "1", b: "2" },
      body,
      now,
    });
    const two = await storeSnapshot(t.db, {
      ...base,
      params: { b: "2", a: "1" },
      body,
      now,
    });
    expect(two.id).toBe(one.id);
    expect(two.changed).toBe(false);
  });

  it("records what the snapshot is about when the caller knows", async () => {
    const result = await storeSnapshot(t.db, {
      ...base,
      body: { x: 1 },
      now: new Date(0),
    });
    const [row] = await t.db
      .select()
      .from(rawSnapshots)
      .where(eq(rawSnapshots.id, result.id));
    expect(row!.seasonId).toBeNull();
    expect(row!.eventId).toBeNull();
    expect(row!.sessionId).toBeNull();
  });
});
