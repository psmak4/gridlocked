import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import { loadCalendar2026 } from "../../tests/helpers/calendar-2026";
import { seedSeats2026 } from "../../tests/helpers/seats-2026";
import {
  constructors,
  drivers,
  eventEntries,
  events,
  seatAssignments,
} from "@/db/schema";
import { simulatedClock } from "@/lib/clock";
import { newId } from "@/lib/ids";
import { syncCalendar } from "./sync-calendar";
import { syncEventEntries } from "./sync-event-entries";

describe("syncEventEntries", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  const clock = simulatedClock(new Date("2026-02-01T00:00:00.000Z"));

  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.close();
  });

  const eventId = async (name: string) =>
    (await t.db.select().from(events).where(eq(events.name, name)))[0]!.id;

  /** Entries as `driver slug -> constructor slug #number (source)`. */
  async function lineUp(id: string) {
    const rows = await t.db
      .select({
        driver: drivers.slug,
        constructor: constructors.slug,
        carNumber: eventEntries.carNumber,
        source: eventEntries.source,
      })
      .from(eventEntries)
      .innerJoin(drivers, eq(drivers.id, eventEntries.driverId))
      .innerJoin(constructors, eq(constructors.id, eventEntries.constructorId))
      .where(eq(eventEntries.eventId, id));
    return new Map(
      rows.map((r) => [
        r.driver,
        {
          constructor: r.constructor,
          carNumber: r.carNumber,
          source: r.source,
        },
      ]),
    );
  }

  /** Calendar first (no seats yet, so no entries), then the seats. */
  async function setup() {
    await syncCalendar(t.db, clock, 2026, {
      events: loadCalendar2026(),
      snapshotId: newId(),
    });
    return seedSeats2026(t.db, clock.now());
  }

  it("copies the race seats active on the first session date", async () => {
    await setup();
    const id = await eventId("Australian Grand Prix");
    expect(await lineUp(id)).toEqual(new Map());

    const report = await syncEventEntries(t.db, id);

    expect(report).toEqual({ inserted: 22, updated: 0, removed: 0 });
    const entries = await lineUp(id);
    expect(entries.size).toBe(22);
    expect(entries.get("max-verstappen")).toEqual({
      constructor: "red-bull",
      carNumber: 3,
      source: "seat",
    });
    expect(entries.get("hadjar")?.constructor).toBe("red-bull");
    expect(entries.get("lawson")?.constructor).toBe("rb");
    expect(entries.has("tsunoda")).toBe(false);
  });

  it("follows the Dutch GP swap, which starts on its first session date", async () => {
    await setup();
    const before = await eventId("Hungarian Grand Prix");
    const dutch = await eventId("Dutch Grand Prix");
    await syncEventEntries(t.db, before);
    await syncEventEntries(t.db, dutch);

    const hungary = await lineUp(before);
    expect(hungary.get("lawson")?.constructor).toBe("rb");
    expect(hungary.get("hadjar")?.constructor).toBe("red-bull");
    expect(hungary.has("tsunoda")).toBe(false);

    const zandvoort = await lineUp(dutch);
    expect(zandvoort.size).toBe(22);
    expect(zandvoort.get("lawson")).toMatchObject({
      constructor: "red-bull",
      carNumber: 30,
    });
    expect(zandvoort.get("tsunoda")).toMatchObject({
      constructor: "rb",
      carNumber: 22,
    });
    expect(zandvoort.has("hadjar")).toBe(false);
  });

  it("is safe to run again", async () => {
    await setup();
    const id = await eventId("Dutch Grand Prix");
    await syncEventEntries(t.db, id);

    expect(await syncEventEntries(t.db, id)).toEqual({
      inserted: 0,
      updated: 0,
      removed: 0,
    });
    expect((await lineUp(id)).size).toBe(22);
  });

  it("never overwrites an admin or results entry", async () => {
    const { driverIds, constructorIds } = await setup();
    const id = await eventId("Dutch Grand Prix");
    await syncEventEntries(t.db, id);
    // An admin moves Verstappen to another number, and adds Hadjar back.
    await t.db
      .update(eventEntries)
      .set({ carNumber: 33, source: "admin" })
      .where(eq(eventEntries.driverId, driverIds.get("max_verstappen")!));
    await t.db.insert(eventEntries).values({
      eventId: id,
      driverId: driverIds.get("hadjar")!,
      constructorId: constructorIds.get("red_bull")!,
      carNumber: 6,
      source: "admin",
    });
    // Results created one for Norris at another team.
    await t.db
      .update(eventEntries)
      .set({
        constructorId: constructorIds.get("ferrari")!,
        source: "results",
      })
      .where(eq(eventEntries.driverId, driverIds.get("norris")!));

    const report = await syncEventEntries(t.db, id);

    expect(report).toEqual({ inserted: 0, updated: 0, removed: 0 });
    const entries = await lineUp(id);
    expect(entries.get("max-verstappen")).toEqual({
      constructor: "red-bull",
      carNumber: 33,
      source: "admin",
    });
    expect(entries.get("hadjar")?.source).toBe("admin");
    expect(entries.get("norris")).toMatchObject({
      constructor: "ferrari",
      source: "results",
    });
    expect(entries.size).toBe(23);
  });

  it("updates a seat copy when the seat changes, and drops one that no longer applies", async () => {
    const { driverIds, constructorIds } = await setup();
    const id = await eventId("Dutch Grand Prix");
    await syncEventEntries(t.db, id);
    // A corrected seat: Tsunoda's number changes, Lawson's new seat is removed.
    await t.db
      .update(seatAssignments)
      .set({ carNumber: 99 })
      .where(eq(seatAssignments.driverId, driverIds.get("tsunoda")!));
    await t.db
      .delete(seatAssignments)
      .where(
        and(
          eq(seatAssignments.driverId, driverIds.get("lawson")!),
          eq(seatAssignments.constructorId, constructorIds.get("red_bull")!),
        ),
      );

    const report = await syncEventEntries(t.db, id, clock.now());

    expect(report).toEqual({ inserted: 0, updated: 1, removed: 1 });
    const entries = await lineUp(id);
    expect(entries.get("tsunoda")?.carNumber).toBe(99);
    expect(entries.has("lawson")).toBe(false);
    expect(entries.size).toBe(21);
  });

  it("reads the first session date in the circuit's own time zone", async () => {
    const { driverIds } = await setup();
    // Las Vegas FP1 is 2026-11-20 00:30 UTC, which is 2026-11-19 locally.
    const id = await eventId("Las Vegas Grand Prix");
    await t.db
      .update(seatAssignments)
      .set({ validTo: "2026-11-19" })
      .where(eq(seatAssignments.driverId, driverIds.get("max_verstappen")!));

    await syncEventEntries(t.db, id);

    expect((await lineUp(id)).has("max-verstappen")).toBe(true);
  });

  it("ignores reserve seats", async () => {
    const { driverIds, constructorIds, seasonId } = await setup();
    await t.db.insert(seatAssignments).values({
      id: newId(),
      seasonId,
      driverId: driverIds.get("tsunoda")!,
      constructorId: constructorIds.get("red_bull")!,
      carNumber: 22,
      role: "reserve",
      validFrom: "2026-03-06",
    });
    const id = await eventId("Australian Grand Prix");

    await syncEventEntries(t.db, id);

    expect((await lineUp(id)).has("tsunoda")).toBe(false);
  });

  it("throws for an event that does not exist", async () => {
    await setup();
    await expect(syncEventEntries(t.db, newId())).rejects.toThrow(/no event/);
  });

  it("is run for each event the calendar sync creates", async () => {
    await seedSeats2026(t.db, clock.now());

    await syncCalendar(t.db, clock, 2026, {
      events: loadCalendar2026(),
      snapshotId: newId(),
    });

    const dutch = await lineUp(await eventId("Dutch Grand Prix"));
    expect(dutch.size).toBe(22);
    expect(dutch.get("tsunoda")?.constructor).toBe("rb");
  });
});
