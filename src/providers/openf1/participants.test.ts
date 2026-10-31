import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb } from "../../../tests/helpers/test-db";
import { readFixture } from "../../../tests/helpers/fixtures";
import { sessionIdFor } from "../../../tests/helpers/results-2026";
import {
  seedEntriesFor,
  seedWorldWithSeats,
} from "../../../tests/helpers/ingest-2026";
import {
  constructors,
  drivers,
  eventEntries,
  providerIds,
  reviewItems,
  sessionParticipants,
} from "@/db/schema";
import { newId } from "@/lib/ids";
import { storeSnapshot } from "../snapshots";
import { OPENF1_TEAMS } from "./teams";
import {
  linkOpenF1Sessions,
  openF1SessionKey,
  parseOpenF1Drivers,
  parseOpenF1Sessions,
  storeParticipants,
} from "./participants";

const NOW = new Date("2026-09-04T16:00:00.000Z");

type DriverRow = Record<string, unknown> & {
  driver_number: number;
  name_acronym: string;
  team_name: string;
};

const load = (file: string) =>
  structuredClone(readFixture(`openf1/2026/${file}`)) as DriverRow[];

describe("parseOpenF1Drivers", () => {
  it("reads the number, team and acronym of every driver", () => {
    const rows = parseOpenF1Drivers(load("drivers-r13-fp2.json"));
    expect(rows).toHaveLength(22);
    expect(rows.find((r) => r.driverNumber === 30)).toEqual({
      driverNumber: 30,
      teamName: "Red Bull Racing",
      acronym: "LAW",
    });
  });

  it("throws on a shape it does not know", () => {
    expect(() => parseOpenF1Drivers({ detail: "Not Found" })).toThrow();
    expect(() => parseOpenF1Drivers([{ driver_number: "x" }])).toThrow();
  });

  it("reads a missing team or acronym as empty text", () => {
    expect(
      parseOpenF1Drivers([
        { driver_number: 99, team_name: null, name_acronym: null },
      ]),
    ).toEqual([{ driverNumber: 99, teamName: "", acronym: "" }]);
  });
});

describe("OpenF1 sessions", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeEach(async () => {
    t = await createTestDb();
    await seedWorldWithSeats(t.db);
  });
  afterEach(async () => {
    await t.close();
  });

  it("reads the practice sessions from the recorded list", () => {
    const list = parseOpenF1Sessions(readFixture("openf1/2026/sessions.json"));
    expect(list.find((s) => s.sessionKey === 11355)).toEqual({
      sessionKey: 11355,
      sessionName: "Practice 2",
      dateStart: "2026-09-04T14:00:00+00:00",
    });
  });

  it("links each practice session once, and again changes nothing", async () => {
    const body = readFixture("openf1/2026/sessions.json");
    const first = await linkOpenF1Sessions(t.db, NOW, body);
    expect(first.linked).toBeGreaterThan(40);

    const fp2 = await sessionIdFor(t.db, 13, "fp2");
    expect(await openF1SessionKey(t.db, fp2)).toBe(11355);
    const dutchFp1 = await sessionIdFor(t.db, 12, "fp1");
    expect(await openF1SessionKey(t.db, dutchFp1)).toBe(11343);

    const again = await linkOpenF1Sessions(t.db, NOW, body);
    expect(again.linked).toBe(0);
    const rows = await t.db
      .select()
      .from(providerIds)
      .where(
        and(
          eq(providerIds.provider, "openf1"),
          eq(providerIds.entityType, "session"),
        ),
      );
    expect(rows).toHaveLength(first.linked);
  });

  it("does not link a session of another kind", async () => {
    await linkOpenF1Sessions(
      t.db,
      NOW,
      readFixture("openf1/2026/sessions.json"),
    );
    const race = await sessionIdFor(t.db, 13, "race");
    expect(await openF1SessionKey(t.db, race)).toBeNull();
  });
});

describe("storeParticipants", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeEach(async () => {
    t = await createTestDb();
    await seedWorldWithSeats(t.db);
  });
  afterEach(async () => {
    await t.close();
  });

  /** A recorded (or edited) body, stored and handed to storeParticipants. */
  async function store(
    sessionId: string,
    body: DriverRow[],
    endpoint = "/drivers",
  ) {
    const { id } = await storeSnapshot(t.db, {
      provider: "openf1",
      endpoint,
      params: { session: sessionId },
      body,
      now: NOW,
      sessionId,
    });
    await storeParticipants(t.db, NOW, sessionId, id, parseOpenF1Drivers(body));
    return id;
  }

  /** `driver slug -> constructor slug` for a session's participants. */
  async function participants(sessionId: string) {
    const rows = await t.db
      .select({ driver: drivers.slug, constructor: constructors.slug })
      .from(sessionParticipants)
      .innerJoin(drivers, eq(drivers.id, sessionParticipants.driverId))
      .innerJoin(
        constructors,
        eq(constructors.id, sessionParticipants.constructorId),
      )
      .where(eq(sessionParticipants.sessionId, sessionId));
    return new Map(rows.map((r) => [r.driver, r.constructor]));
  }

  const items = () => t.db.select().from(reviewItems);

  it("maps every driver of the round 13 FP2 fixture", async () => {
    const fp2 = await sessionIdFor(t.db, 13, "fp2");
    const snapshotId = await store(fp2, load("drivers-r13-fp2.json"));

    const map = await participants(fp2);
    expect(map.size).toBe(22);
    expect(map.get("lawson")).toBe("red-bull");
    expect(map.get("tsunoda")).toBe("rb");
    expect(map.get("hadjar")).toBeUndefined();
    expect(await items()).toEqual([]);

    const [row] = await t.db
      .select()
      .from(sessionParticipants)
      .where(eq(sessionParticipants.sessionId, fp2))
      .limit(1);
    expect(row).toMatchObject({ provider: "openf1", snapshotId });

    // The participants agree with the entries of the weekend.
    await seedEntriesFor(t.db, fp2);
    const entries = await t.db.select().from(eventEntries);
    const byDriver = new Map(entries.map((e) => [e.driverId, e.constructorId]));
    const stored = await t.db.select().from(sessionParticipants);
    expect(stored).toHaveLength(22);
    for (const p of stored) {
      expect(byDriver.get(p.driverId)).toBe(p.constructorId);
    }
  });

  it("uses the seat that is active on the session date (Dutch GP swap)", async () => {
    const fp1 = await sessionIdFor(t.db, 12, "fp1");
    await store(fp1, load("drivers-r12-fp1.json"));
    const map = await participants(fp1);
    expect(map.size).toBe(22);
    expect(map.get("lawson")).toBe("red-bull");
    expect(map.get("tsunoda")).toBe("rb");
    expect(await items()).toEqual([]);
  });

  it("maps the reversal weekend back (round 15 FP2)", async () => {
    const fp2 = await sessionIdFor(t.db, 15, "fp2");
    await store(fp2, load("drivers-r15-fp2.json"));
    const map = await participants(fp2);
    expect(map.size).toBe(22);
    expect(map.get("hadjar")).toBe("red-bull");
    expect(map.get("lawson")).toBe("rb");
    expect(map.has("tsunoda")).toBe(false);
    expect(await items()).toEqual([]);
  });

  it("falls back to the acronym when the number is not a seat's", async () => {
    const fp2 = await sessionIdFor(t.db, 13, "fp2");
    const body = load("drivers-r13-fp2.json");
    body.find((r) => r.name_acronym === "NOR")!.driver_number = 91;
    await store(fp2, body);
    const map = await participants(fp2);
    expect(map.size).toBe(22);
    expect(map.get("norris")).toBe("mclaren");
    expect(await items()).toEqual([]);
  });

  it("maps a driver with no seat by acronym and the team's name", async () => {
    // Hadjar has no race seat on the Dutch GP weekend, and number 6 is nobody's.
    const fp1 = await sessionIdFor(t.db, 12, "fp1");
    const body = load("drivers-r12-fp1.json");
    body.push({
      ...body[0]!,
      driver_number: 6,
      name_acronym: "HAD",
      team_name: "Red Bull Racing",
    });
    await store(fp1, body);
    const map = await participants(fp1);
    expect(map.size).toBe(23);
    expect(map.get("hadjar")).toBe("red-bull");
    expect(await items()).toEqual([]);
  });

  it("opens one unknown_driver warning for a driver it cannot map", async () => {
    const fp2 = await sessionIdFor(t.db, 13, "fp2");
    const body = load("drivers-r13-fp2.json");
    body.push({
      ...body[0]!,
      driver_number: 99,
      name_acronym: "ZZZ",
      team_name: "McLaren",
    });
    await store(fp2, body);
    await store(fp2, body);

    expect((await participants(fp2)).size).toBe(22);
    const open = await items();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      kind: "unknown_driver",
      severity: "warning",
      status: "open",
      sessionId: fp2,
      dedupeKey: `openf1_unknown:${fp2}:99`,
    });
    expect(open[0]!.details).toMatchObject({
      provider: "openf1",
      driverNumber: 99,
      acronym: "ZZZ",
    });
  });

  it("replaces the session's participants in one go", async () => {
    const fp2 = await sessionIdFor(t.db, 13, "fp2");
    await store(fp2, load("drivers-r13-fp2.json"));
    await store(fp2, load("drivers-r13-fp2.json").slice(0, 5));
    expect((await participants(fp2)).size).toBe(5);
  });

  it("keeps the stored participants when the provider sends none", async () => {
    const fp2 = await sessionIdFor(t.db, 13, "fp2");
    await store(fp2, load("drivers-r13-fp2.json"));
    await store(fp2, [], "/drivers-empty");
    expect((await participants(fp2)).size).toBe(22);
  });

  it("takes the constructor from the team name, not the seat", async () => {
    const fp3 = await sessionIdFor(t.db, 13, "fp3");
    // OpenF1 shows Lawson (seat: red_bull) in a Racing Bulls car.
    const body = load("drivers-r13-fp3.json");
    body.find((r) => r.name_acronym === "LAW")!.team_name = "Racing Bulls";
    await store(fp3, body);
    expect((await participants(fp3)).get("lawson")).toBe("rb");
    expect(await items()).toEqual([]);
    // Nothing is learned into provider_ids.
    const learned = await t.db
      .select()
      .from(providerIds)
      .where(
        and(
          eq(providerIds.provider, "openf1"),
          eq(providerIds.entityType, "constructor"),
        ),
      );
    expect(learned).toEqual([]);
  });

  it("maps all eleven 2026 team names", () => {
    const names = new Set<string>();
    for (const f of [
      "drivers-r12-fp1.json",
      "drivers-r13-fp2.json",
      "drivers-r15-fp2.json",
    ]) {
      for (const r of load(f)) names.add(r.team_name);
    }
    expect([...names].sort()).toEqual(Object.keys(OPENF1_TEAMS).sort());
    expect(names.size).toBe(11);
  });

  it("opens an unknown_team warning and skips the row for an unmapped team", async () => {
    const fp2 = await sessionIdFor(t.db, 13, "fp2");
    const body = load("drivers-r13-fp2.json");
    body.find((r) => r.name_acronym === "NOR")!.team_name = "Brawn GP";
    body.find((r) => r.name_acronym === "PIA")!.team_name = "Brawn GP";
    await store(fp2, body);
    await store(fp2, body);

    const map = await participants(fp2);
    expect(map.size).toBe(20);
    expect(map.has("norris")).toBe(false);
    const open = await items();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({
      kind: "unknown_driver",
      severity: "warning",
      sessionId: fp2,
      dedupeKey: `openf1_unknown_team:${fp2}:Brawn GP`,
    });
    expect(open[0]!.details).toMatchObject({
      reason: "unknown_team",
      teamName: "Brawn GP",
    });
  });

  it("a substitute entered for the event is matched by the entry's car number", async () => {
    // Mexico City 2026: Hirakawa had no seat and no driver code.
    const fp2 = await sessionIdFor(t.db, 13, "fp2");
    const eventId = await seedEntriesFor(t.db, fp2);
    const hirakawa = newId();
    await t.db.insert(drivers).values({
      id: hirakawa,
      slug: "hirakawa",
      givenName: "Ryo",
      familyName: "Hirakawa",
      code: null,
      nationality: "Japanese",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const [haas] = await t.db
      .select({ id: providerIds.entityId })
      .from(providerIds)
      .where(
        and(
          eq(providerIds.provider, "jolpica"),
          eq(providerIds.entityType, "constructor"),
          eq(providerIds.providerKey, "haas"),
        ),
      );
    await t.db.insert(eventEntries).values({
      eventId,
      driverId: hirakawa,
      constructorId: haas!.id,
      carNumber: 99,
      source: "admin",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const body = load("drivers-r13-fp2.json");
    const haasRow = body.find((r) => OPENF1_TEAMS[r.team_name] === "haas")!;
    body.push({
      ...haasRow,
      driver_number: 99,
      name_acronym: "HIR",
    });
    await store(fp2, body);
    const map = await participants(fp2);
    expect(map.size).toBe(23);
    expect(map.get("hirakawa")).toBe(map.get("bearman"));
    expect(await items()).toEqual([]);
  });

  it("does not map a lone acronym match that has no seat this season", async () => {
    const fp2 = await sessionIdFor(t.db, 13, "fp2");
    await t.db.insert(drivers).values({
      id: newId(),
      slug: "old-timer",
      givenName: "Old",
      familyName: "Timer",
      code: "OLD",
      nationality: "n/a",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const body = load("drivers-r13-fp2.json");
    body.push({
      ...body[0]!,
      driver_number: 99,
      name_acronym: "OLD",
      team_name: "McLaren",
    });
    await store(fp2, body);
    expect((await participants(fp2)).size).toBe(22);
    const open = await items();
    expect(open).toHaveLength(1);
    expect(open[0]!.details).toMatchObject({
      reason: "no_driver",
      driverNumber: 99,
    });
  });
});
