import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import { newId } from "@/lib/ids";
import {
  circuits,
  constructors,
  drivers,
  events,
  providerIds,
  seasons,
  seatAssignments,
  sessions,
} from "./schema";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

/**
 * Asserts that `promise` rejects with the given Postgres SQLSTATE. Drizzle
 * wraps driver errors, so the code is read from the error or its cause.
 */
async function expectPgError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, "expected the statement to be rejected").toBeDefined();
  const direct = (error as { code?: string }).code;
  const cause = (error as { cause?: { code?: string } }).cause?.code;
  expect(direct ?? cause).toBe(code);
}

const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const FOREIGN_KEY_VIOLATION = "23503";
const EXCLUSION_VIOLATION = "23P01";
// ON DELETE RESTRICT reports restrict_violation, not foreign_key_violation.
const RESTRICT_VIOLATION = "23001";

describe("reference schema (DM Part 1)", () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await createTestDb();
  });

  afterEach(async () => {
    await t.close();
  });

  async function insertSeason(year = 2026) {
    const id = newId();
    await t.db.insert(seasons).values({ id, year, status: "active" });
    return id;
  }

  async function insertCircuit(slug = "monaco") {
    const id = newId();
    await t.db.insert(circuits).values({
      id,
      slug,
      name: "Circuit de Monaco",
      locality: "Monte-Carlo",
      country: "Monaco",
      latitude: "43.734700",
      longitude: "7.420560",
      timezone: "Europe/Monaco",
    });
    return id;
  }

  async function insertEvent(
    seasonId: string,
    circuitId: string,
    round: number,
    overrides: Partial<typeof events.$inferInsert> = {},
  ) {
    const id = newId();
    await t.db.insert(events).values({
      id,
      seasonId,
      round,
      slug: `2026-event-${round}-${id}`,
      name: `Grand Prix ${round}`,
      circuitId,
      format: "standard",
      status: "scheduled",
      lockAt: new Date("2026-06-06T14:00:00Z"),
      lockAtSource: "default",
      ...overrides,
    });
    return id;
  }

  async function insertDriver(slug: string) {
    const id = newId();
    await t.db.insert(drivers).values({
      id,
      slug,
      givenName: "Given",
      familyName: slug,
      nationality: "Dutch",
    });
    return id;
  }

  async function insertConstructor(slug: string) {
    const id = newId();
    await t.db
      .insert(constructors)
      .values({ id, slug, name: slug, nationality: "Austrian" });
    return id;
  }

  function seat(
    seasonId: string,
    driverId: string,
    constructorId: string,
    carNumber: number,
    validFrom: string,
    validTo: string | null,
    role: "race" | "reserve" = "race",
  ) {
    return t.db.insert(seatAssignments).values({
      id: newId(),
      seasonId,
      driverId,
      constructorId,
      carNumber,
      role,
      validFrom,
      validTo,
    });
  }

  describe("events (season_id, round) is deferrable", () => {
    async function twoEvents() {
      const seasonId = await insertSeason();
      const circuitId = await insertCircuit();
      const a = await insertEvent(seasonId, circuitId, 1);
      const b = await insertEvent(seasonId, circuitId, 2);
      return { a, b };
    }

    it("lets a calendar be renumbered in one transaction with the constraint deferred", async () => {
      const { a, b } = await twoEvents();

      await t.db.transaction(async (tx) => {
        await tx.execute(sql`set constraints all deferred`);
        await tx.update(events).set({ round: 2 }).where(eq(events.id, a));
        await tx.update(events).set({ round: 1 }).where(eq(events.id, b));
      });

      const rows = await t.db.select().from(events);
      expect(rows.find((r) => r.id === a)?.round).toBe(2);
      expect(rows.find((r) => r.id === b)?.round).toBe(1);
    });

    it("rejects the same swap when the constraint is not deferred", async () => {
      const { a, b } = await twoEvents();

      await expectPgError(
        t.db.transaction(async (tx) => {
          await tx.update(events).set({ round: 2 }).where(eq(events.id, a));
          await tx.update(events).set({ round: 1 }).where(eq(events.id, b));
        }),
        UNIQUE_VIOLATION,
      );
    });

    it("still rejects a duplicate round once the deferred check runs", async () => {
      const { a } = await twoEvents();

      await expectPgError(
        t.db.transaction(async (tx) => {
          await tx.execute(sql`set constraints all deferred`);
          await tx.update(events).set({ round: 2 }).where(eq(events.id, a));
        }),
        UNIQUE_VIOLATION,
      );
    });
  });

  describe("events.lock_session_id and sessions.event_id", () => {
    it("allows event, then sessions, then lock_session_id to be set", async () => {
      const seasonId = await insertSeason();
      const circuitId = await insertCircuit();
      const eventId = await insertEvent(seasonId, circuitId, 1);
      const sessionId = newId();
      await t.db.insert(sessions).values({
        id: sessionId,
        eventId,
        kind: "qualifying",
        scheduledStart: new Date("2026-06-06T14:00:00Z"),
        startConfirmed: true,
        scheduledEnd: new Date("2026-06-06T15:00:00Z"),
        timeSource: "provider",
        status: "scheduled",
      });

      await t.db
        .update(events)
        .set({ lockSessionId: sessionId })
        .where(eq(events.id, eventId));

      const [row] = await t.db
        .select()
        .from(events)
        .where(eq(events.id, eventId));
      expect(row?.lockSessionId).toBe(sessionId);
    });

    it("rejects a lock_session_id that is not a session", async () => {
      const seasonId = await insertSeason();
      const circuitId = await insertCircuit();
      await expectPgError(
        insertEvent(seasonId, circuitId, 1, { lockSessionId: newId() }),
        FOREIGN_KEY_VIOLATION,
      );
    });
  });

  describe("sessions", () => {
    async function insertSession(
      eventId: string,
      overrides: Partial<typeof sessions.$inferInsert> = {},
    ) {
      await t.db.insert(sessions).values({
        id: newId(),
        eventId,
        kind: "race",
        scheduledStart: new Date("2026-06-07T13:00:00Z"),
        startConfirmed: true,
        scheduledEnd: new Date("2026-06-07T15:00:00Z"),
        timeSource: "provider",
        status: "scheduled",
        ...overrides,
      });
    }

    it("defaults sequence to 1 and makes (event_id, kind, sequence) unique", async () => {
      const seasonId = await insertSeason();
      const circuitId = await insertCircuit();
      const eventId = await insertEvent(seasonId, circuitId, 1);

      await insertSession(eventId);
      const [first] = await t.db.select().from(sessions);
      expect(first?.sequence).toBe(1);

      await expectPgError(insertSession(eventId), UNIQUE_VIOLATION);
      // A second session of the same kind is allowed with another sequence.
      await insertSession(eventId, { sequence: 2 });
    });
  });

  describe("seat_assignments exclusion constraints (race seats)", () => {
    it("rejects a driver holding two overlapping race seats", async () => {
      const seasonId = await insertSeason();
      const driver = await insertDriver("max-verstappen");
      const redBull = await insertConstructor("red-bull");
      const rb = await insertConstructor("rb");

      await seat(seasonId, driver, redBull, 3, "2026-03-01", null);
      await expectPgError(
        seat(seasonId, driver, rb, 4, "2026-06-01", null),
        EXCLUSION_VIOLATION,
      );
    });

    it("allows a reserve seat to overlap a race seat", async () => {
      const seasonId = await insertSeason();
      const driver = await insertDriver("max-verstappen");
      const redBull = await insertConstructor("red-bull");
      const rb = await insertConstructor("rb");

      await seat(seasonId, driver, redBull, 3, "2026-03-01", null);
      await seat(seasonId, driver, rb, 40, "2026-06-01", null, "reserve");

      const rows = await t.db.select().from(seatAssignments);
      expect(rows).toHaveLength(2);
    });

    it("allows a swap that closes one range on 2026-08-20 and opens the next on 2026-08-21", async () => {
      const seasonId = await insertSeason();
      const driver = await insertDriver("liam-lawson");
      const rb = await insertConstructor("rb");
      const redBull = await insertConstructor("red-bull");

      await seat(seasonId, driver, rb, 30, "2026-03-01", "2026-08-20");
      await seat(seasonId, driver, redBull, 30, "2026-08-21", null);

      const rows = await t.db.select().from(seatAssignments);
      expect(rows).toHaveLength(2);
    });

    it("treats valid_to as inclusive: opening the next seat on the closing day overlaps", async () => {
      const seasonId = await insertSeason();
      const driver = await insertDriver("liam-lawson");
      const rb = await insertConstructor("rb");
      const redBull = await insertConstructor("red-bull");

      await seat(seasonId, driver, rb, 30, "2026-03-01", "2026-08-20");
      await expectPgError(
        seat(seasonId, driver, redBull, 31, "2026-08-20", null),
        EXCLUSION_VIOLATION,
      );
    });

    it("rejects two race seats with car number 30 in overlapping ranges", async () => {
      const seasonId = await insertSeason();
      const lawson = await insertDriver("liam-lawson");
      const tsunoda = await insertDriver("yuki-tsunoda");
      const rb = await insertConstructor("rb");
      const redBull = await insertConstructor("red-bull");

      await seat(seasonId, lawson, rb, 30, "2026-03-01", null);
      await expectPgError(
        seat(seasonId, tsunoda, redBull, 30, "2026-06-01", null),
        EXCLUSION_VIOLATION,
      );
    });

    it("allows the same car number in non-overlapping ranges and in another season", async () => {
      const seasonId = await insertSeason(2026);
      const otherSeasonId = await insertSeason(2027);
      const lawson = await insertDriver("liam-lawson");
      const tsunoda = await insertDriver("yuki-tsunoda");
      const rb = await insertConstructor("rb");

      await seat(seasonId, lawson, rb, 30, "2026-03-01", "2026-08-20");
      await seat(seasonId, tsunoda, rb, 30, "2026-08-21", null);
      await seat(otherSeasonId, lawson, rb, 30, "2027-03-01", null);

      const rows = await t.db.select().from(seatAssignments);
      expect(rows).toHaveLength(3);
    });

    it("rejects a seat whose valid_to is before valid_from", async () => {
      const seasonId = await insertSeason();
      const driver = await insertDriver("max-verstappen");
      const redBull = await insertConstructor("red-bull");

      await expectPgError(
        seat(
          seasonId,
          driver,
          redBull,
          3,
          "2026-08-21",
          "2026-08-20",
          "reserve",
        ),
        CHECK_VIOLATION,
      );
    });
  });

  describe("CHECK constraints", () => {
    it("rejects an events.status of 'postponed'", async () => {
      const seasonId = await insertSeason();
      const circuitId = await insertCircuit();

      await expectPgError(
        insertEvent(seasonId, circuitId, 1, {
          status: "postponed" as "scheduled",
        }),
        CHECK_VIOLATION,
      );
    });

    it("rejects an unknown season status, session kind and constructor color", async () => {
      await expectPgError(
        t.db
          .insert(seasons)
          .values({ id: newId(), year: 2030, status: "later" as "upcoming" }),
        CHECK_VIOLATION,
      );

      const seasonId = await insertSeason();
      const circuitId = await insertCircuit();
      const eventId = await insertEvent(seasonId, circuitId, 1);
      await expectPgError(
        t.db.insert(sessions).values({
          id: newId(),
          eventId,
          kind: "warmup" as "race",
          scheduledStart: new Date("2026-06-07T13:00:00Z"),
          startConfirmed: true,
          scheduledEnd: new Date("2026-06-07T15:00:00Z"),
          timeSource: "provider",
          status: "scheduled",
        }),
        CHECK_VIOLATION,
      );

      const constructorId = await insertConstructor("red-bull");
      await expectPgError(
        t.db.execute(
          sql`insert into constructor_seasons (constructor_id, season_id, display_name, short_name, color)
              values (${constructorId}, ${seasonId}, 'Red Bull', 'RBR', 'blue')`,
        ),
        CHECK_VIOLATION,
      );
    });
  });

  describe("foreign keys are RESTRICT", () => {
    it("fails to delete a season that has events", async () => {
      const seasonId = await insertSeason();
      const circuitId = await insertCircuit();
      await insertEvent(seasonId, circuitId, 1);

      await expectPgError(
        t.db.delete(seasons).where(eq(seasons.id, seasonId)),
        RESTRICT_VIOLATION,
      );
      const rows = await t.db.select().from(seasons);
      expect(rows).toHaveLength(1);
    });

    it("fails to delete an event that has sessions", async () => {
      const seasonId = await insertSeason();
      const circuitId = await insertCircuit();
      const eventId = await insertEvent(seasonId, circuitId, 1);
      await t.db.insert(sessions).values({
        id: newId(),
        eventId,
        kind: "race",
        scheduledStart: new Date("2026-06-07T13:00:00Z"),
        startConfirmed: true,
        scheduledEnd: new Date("2026-06-07T15:00:00Z"),
        timeSource: "provider",
        status: "scheduled",
      });

      await expectPgError(
        t.db.delete(events).where(eq(events.id, eventId)),
        RESTRICT_VIOLATION,
      );
    });
  });

  describe("provider_ids", () => {
    it("is unique on (provider, entity_type, provider_key) and on (provider, entity_type, entity_id)", async () => {
      const a = await insertDriver("max-verstappen");
      const b = await insertDriver("lando-norris");
      const row = (provider: string, providerKey: string, entityId: string) =>
        t.db.insert(providerIds).values({
          provider,
          entityType: "driver",
          providerKey,
          entityId,
        });

      await row("jolpica", "max_verstappen", a);

      // Same provider key for a different entity.
      await expectPgError(
        row("jolpica", "max_verstappen", b),
        UNIQUE_VIOLATION,
      );
      // Same entity under a second provider key.
      await expectPgError(row("jolpica", "verstappen", a), UNIQUE_VIOLATION);
      // Another provider may use the same key and entity.
      await row("openf1", "1", a);
    });
  });
});
