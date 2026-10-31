import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import {
  loadOpenF1Drivers,
  rematchParticipants,
  storeOpenF1Participants,
} from "../../tests/helpers/openf1-2026";
import { sessionIdFor } from "../../tests/helpers/results-2026";
import {
  idFor,
  ingestWithSubstitute,
  seedWorldWithSeats,
} from "../../tests/helpers/ingest-2026";
import {
  auditLog,
  driverAvailability,
  drivers,
  eventEntries,
  events,
  reviewItems,
  seatAssignments,
  sessionResultState,
} from "@/db/schema";
import { advanceStatus } from "@/results/status";
import { syncEventEntries } from "@/reference/sync-event-entries";
import { newId } from "@/lib/ids";
import { changeSeats, recordSubstitution, type StaffActor } from "./roster";

const T0 = new Date("2026-10-04T08:00:00.000Z");
const T1 = new Date("2026-10-04T09:00:00.000Z");
const T2 = new Date("2026-10-05T09:00:00.000Z");
const ACTOR: StaffActor = { kind: "admin", label: "psmak4" };
const REASON = "Tsunoda replaces Ocon from FP3 (team announcement)";

describe("staff roster actions", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeEach(async () => {
    t = await createTestDb();
    await seedWorldWithSeats(t.db);
  });
  afterEach(async () => {
    await t.close();
  });

  const status = async (sessionId: string) =>
    (
      await t.db
        .select({ status: sessionResultState.status })
        .from(sessionResultState)
        .where(eq(sessionResultState.sessionId, sessionId))
    )[0]?.status;
  const entriesOf = (eventId: string) =>
    t.db.select().from(eventEntries).where(eq(eventEntries.eventId, eventId));
  const audits = () => t.db.select().from(auditLog);

  /**
   * Round 18 set up as Mexico City 2026: Tsunoda (no race seat by then)
   * drives Ocon's Haas car in qualifying and the race, and nobody has
   * recorded it yet, so both sessions are held.
   */
  async function unrecordedSwap() {
    const swap = {
      replaced: "ocon",
      sub: "tsunoda",
      constructorKey: "haas",
      car: 22,
      enter: false,
    };
    const q = await ingestWithSubstitute(
      t.db,
      T0,
      18,
      "qualifying",
      "r18-qualifying.json",
      swap,
    );
    const r = await ingestWithSubstitute(
      t.db,
      T0,
      18,
      "race",
      "r18-results.json",
      swap,
    );
    await advanceStatus(t.db, T0, q.sessionId);
    await advanceStatus(t.db, T0, r.sessionId);
    return {
      eventId: r.eventId,
      qualifying: q.sessionId,
      race: r.sessionId,
      tsunoda: await idFor(t.db, "driver", "tsunoda"),
      ocon: await idFor(t.db, "driver", "ocon"),
      haas: await idFor(t.db, "constructor", "haas"),
    };
  }

  const substitute = (
    w: Awaited<ReturnType<typeof unrecordedSwap>>,
    at = T1,
    over: Partial<Parameters<typeof recordSubstitution>[2]> = {},
  ) =>
    recordSubstitution(t.db, at, {
      eventId: w.eventId,
      inDriverId: w.tsunoda,
      constructorId: w.haas,
      carNumber: 22,
      outDriverId: w.ocon,
      reason: REASON,
      actor: ACTOR,
      ...over,
    });

  describe("recordSubstitution", () => {
    it("Mexico: a substitution after the race clears the hold", async () => {
      const w = await unrecordedSwap();
      expect(await status(w.qualifying)).toBe("under_review");
      expect(await status(w.race)).toBe("under_review");

      const report = await substitute(w);
      expect(report.changed).toBe(true);
      expect(await status(w.qualifying)).toBe("provisional");
      expect(await status(w.race)).toBe("provisional");
      expect(
        report.sessions.map((s) => [s.kind, s.previous, s.next]).sort(),
      ).toEqual([
        ["qualifying", "under_review", "provisional"],
        ["race", "under_review", "provisional"],
      ]);

      const held = await t.db
        .select()
        .from(reviewItems)
        .where(
          and(
            eq(reviewItems.eventId, w.eventId),
            eq(reviewItems.severity, "blocking"),
            eq(reviewItems.status, "open"),
          ),
        );
      expect(held).toEqual([]);

      const [availability] = await t.db
        .select()
        .from(driverAvailability)
        .where(
          and(
            eq(driverAvailability.eventId, w.eventId),
            eq(driverAvailability.driverId, w.ocon),
          ),
        );
      expect(availability).toMatchObject({
        status: "unavailable",
        reason: REASON,
        source: "admin",
      });

      const rows = await audits();
      expect(rows.map((a) => a.action).sort()).toEqual([
        "driver_availability.update",
        "event_entry.create",
      ]);
      for (const a of rows) {
        expect(a).toMatchObject({
          actorKind: "admin",
          actorLabel: "psmak4",
          reason: REASON,
          createdAt: T1,
        });
      }
    });

    it("the next calendar sync keeps both entries", async () => {
      const w = await unrecordedSwap();
      await substitute(w);
      await syncEventEntries(t.db, w.eventId, T2);
      const haas = (await entriesOf(w.eventId)).filter(
        (e) => e.constructorId === w.haas,
      );
      expect(haas.map((e) => [e.driverId, e.source]).sort()).toEqual(
        [
          [w.ocon, "seat"],
          [w.tsunoda, "admin"],
          [await idFor(t.db, "driver", "bearman"), "seat"],
        ].sort(),
      );
    });

    it("running it twice changes nothing and writes no second audit row", async () => {
      const w = await unrecordedSwap();
      await substitute(w);
      const again = await substitute(w, T2);
      expect(again.changed).toBe(false);
      expect(await audits()).toHaveLength(2);
      expect(await status(w.race)).toBe("provisional");
    });

    it("a final session stays final", async () => {
      const w = await unrecordedSwap();
      await substitute(w);
      await t.db
        .update(sessionResultState)
        .set({ status: "final", finalizedAt: T1 })
        .where(eq(sessionResultState.sessionId, w.qualifying));
      const report = await substitute(w, T2, { reason: "re-run" });
      expect(await status(w.qualifying)).toBe("final");
      expect(
        report.sessions.find((s) => s.sessionId === w.qualifying),
      ).toMatchObject({ previous: "final", next: "final" });
    });

    it("a substitute who already has an entry is updated, not duplicated", async () => {
      const w = await unrecordedSwap();
      const lawson = await idFor(t.db, "driver", "lawson");
      const rb = await idFor(t.db, "constructor", "rb");
      await substitute(w, T1, { inDriverId: lawson, carNumber: 30 });
      const mine = (await entriesOf(w.eventId)).filter(
        (e) => e.driverId === lawson,
      );
      expect(mine).toEqual([
        expect.objectContaining({
          constructorId: w.haas,
          carNumber: 30,
          source: "admin",
        }),
      ]);
      const [update] = (await audits()).filter(
        (a) => a.action === "event_entry.update",
      );
      expect(update).toMatchObject({
        before: { constructorId: rb, source: "seat" },
        after: { constructorId: w.haas, source: "admin" },
      });
    });

    it("recorded after FP3's participants are stored, the swap leaves no roster warning", async () => {
      // The Mexico timeline: FP3 ran with the reserve, who has no seat and no
      // code, so his row was left out; staff record the swap afterwards.
      const fp2 = await sessionIdFor(t.db, 13, "fp2");
      const fp3 = await sessionIdFor(t.db, 13, "fp3");
      const [r13] = await t.db
        .select()
        .from(events)
        .where(eq(events.round, 13));
      const eventId = r13!.id;
      await syncEventEntries(t.db, eventId, T0);
      const reserve = newId();
      await t.db.insert(drivers).values({
        id: reserve,
        slug: "reserve",
        givenName: "Re",
        familyName: "Serve",
        code: null,
        nationality: "n/a",
        createdAt: T0,
        updatedAt: T0,
      });
      await storeOpenF1Participants(
        t.db,
        T0,
        fp2,
        loadOpenF1Drivers("drivers-r13-fp2.json"),
      );
      const fp3Body = loadOpenF1Drivers("drivers-r13-fp3.json");
      const strollRow = fp3Body.find((r) => r.name_acronym === "STR")!;
      strollRow.driver_number = 99;
      strollRow.name_acronym = "RES";
      await storeOpenF1Participants(t.db, T0, fp3, fp3Body);

      const open = () =>
        t.db
          .select({ kind: reviewItems.kind })
          .from(reviewItems)
          .where(
            and(
              eq(reviewItems.eventId, eventId),
              eq(reviewItems.status, "open"),
            ),
          );
      expect((await open()).map((i) => i.kind)).toEqual(["unknown_driver"]);

      await recordSubstitution(
        t.db,
        T1,
        {
          eventId,
          inDriverId: reserve,
          constructorId: await idFor(t.db, "constructor", "aston_martin"),
          carNumber: 99,
          outDriverId: await idFor(t.db, "driver", "stroll"),
          reason: REASON,
          actor: ACTOR,
        },
        { rematchParticipants },
      );
      expect(await open()).toEqual([]);
    });

    it.each([
      ["a blank reason", { reason: "  " }, /reason/],
      [
        "an out driver not entered for that team",
        "hamilton-out",
        /not entered/,
      ],
      ["a clashing car number", { carNumber: 44 }, /car 44/],
    ])("refuses %s, with nothing written", async (_, over, error) => {
      const w = await unrecordedSwap();
      const before = await entriesOf(w.eventId);
      const input =
        over === "hamilton-out"
          ? { outDriverId: await idFor(t.db, "driver", "hamilton") }
          : (over as Partial<Parameters<typeof recordSubstitution>[2]>);
      await expect(substitute(w, T1, input)).rejects.toThrow(error);
      expect(await entriesOf(w.eventId)).toEqual(before);
      expect(await audits()).toEqual([]);
      expect(await t.db.select().from(driverAvailability)).toEqual([]);
    });
  });

  describe("changeSeats", () => {
    const round = async (n: number) => {
      const [e] = await t.db.select().from(events).where(eq(events.round, n));
      return e!;
    };

    it("moves a seat from an event onward and leaves earlier rounds alone", async () => {
      // Tsunoda takes Ocon's Haas seat for good from round 20.
      const tsunoda = await idFor(t.db, "driver", "tsunoda");
      const ocon = await idFor(t.db, "driver", "ocon");
      const haas = await idFor(t.db, "constructor", "haas");
      const r19 = await round(19);
      const r20 = await round(20);
      await syncEventEntries(t.db, r19.id, T0);
      const r19Before = await entriesOf(r19.id);

      const report = await changeSeats(t.db, T1, {
        fromEventId: r20.id,
        changes: [
          { driverId: ocon, constructorId: null },
          { driverId: tsunoda, constructorId: haas, carNumber: 22 },
        ],
        reason: "Tsunoda replaces Ocon from Brazil",
        actor: ACTOR,
      });
      expect(report.eventsSynced).toBeGreaterThan(0);

      const seats = await t.db
        .select()
        .from(seatAssignments)
        .where(eq(seatAssignments.role, "race"));
      const oconSeat = seats.find(
        (s) => s.driverId === ocon && s.constructorId === haas,
      )!;
      const tsunodaSeat = seats.find(
        (s) => s.driverId === tsunoda && s.constructorId === haas,
      )!;
      expect(oconSeat.validTo).toBe("2026-11-05");
      expect(tsunodaSeat).toMatchObject({
        validFrom: "2026-11-06",
        validTo: null,
        carNumber: 22,
      });

      const r20Haas = (await entriesOf(r20.id))
        .filter((e) => e.constructorId === haas)
        .map((e) => e.driverId)
        .sort();
      expect(r20Haas).toEqual(
        [await idFor(t.db, "driver", "bearman"), tsunoda].sort(),
      );
      expect(await entriesOf(r19.id)).toEqual(r19Before);
      expect((await audits()).map((a) => a.action).sort()).toEqual([
        "seat_assignment.close",
        "seat_assignment.open",
      ]);
    });

    it("running it twice changes nothing and writes no second audit row", async () => {
      const tsunoda = await idFor(t.db, "driver", "tsunoda");
      const ocon = await idFor(t.db, "driver", "ocon");
      const haas = await idFor(t.db, "constructor", "haas");
      const input = {
        fromEventId: (await round(20)).id,
        changes: [
          { driverId: ocon, constructorId: null },
          { driverId: tsunoda, constructorId: haas, carNumber: 22 },
        ],
        reason: "Tsunoda replaces Ocon from Brazil",
        actor: ACTOR,
      };
      await changeSeats(t.db, T1, input);
      const seats = await t.db.select().from(seatAssignments);
      await changeSeats(t.db, T2, input);
      expect(await t.db.select().from(seatAssignments)).toEqual(seats);
      expect(await audits()).toHaveLength(2);
    });

    it("refuses a seat that starts on or after the from date", async () => {
      // Lawson's Red Bull seat starts on the Dutch GP's first day (round 12).
      const lawson = await idFor(t.db, "driver", "lawson");
      const rb = await idFor(t.db, "constructor", "rb");
      await expect(
        changeSeats(t.db, T1, {
          fromEventId: (await round(12)).id,
          changes: [{ driverId: lawson, constructorId: rb, carNumber: 30 }],
          reason: "test",
          actor: ACTOR,
        }),
      ).rejects.toThrow(/starts on or after/);
      expect(await audits()).toEqual([]);
    });
  });
});
