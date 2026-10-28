import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import { loadCalendar2026 } from "../../tests/helpers/calendar-2026";
import {
  circuits,
  events,
  providerIds,
  reviewItems,
  seasons,
  sessions,
} from "@/db/schema";
import { simulatedClock } from "@/lib/clock";
import { newId } from "@/lib/ids";
import type { CalendarEvent } from "./calendar-types";
import { syncCalendar } from "./sync-calendar";

const MINUTE = 60_000;

describe("syncCalendar", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  const clock = simulatedClock(new Date("2026-02-01T00:00:00.000Z"));

  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.close();
  });

  const sync = (list: CalendarEvent[]) =>
    syncCalendar(t.db, clock, 2026, { events: list, snapshotId: newId() });

  const allEvents = () =>
    t.db.select().from(events).orderBy(asc(events.round), asc(events.slug));
  const eventByName = async (name: string) =>
    (await t.db.select().from(events).where(eq(events.name, name)))[0]!;
  const sessionsOf = (eventId: string) =>
    t.db.select().from(sessions).where(eq(sessions.eventId, eventId));
  const reviews = () => t.db.select().from(reviewItems);
  const eventKeys = async () =>
    new Map(
      (
        await t.db
          .select()
          .from(providerIds)
          .where(eq(providerIds.entityType, "event"))
      ).map((r) => [r.entityId, r.providerKey]),
    );

  /** The calendar with the named event moved to `round`, rounds renumbered. */
  function moveEvent(
    list: CalendarEvent[],
    name: string,
    round: number,
  ): CalendarEvent[] {
    const moving = list.find((e) => e.name === name)!;
    const rest = list.filter((e) => e !== moving);
    rest.splice(round - 1, 0, moving);
    return rest.map((e, i) => ({
      ...e,
      round: i + 1,
      key: `2026/${i + 1}`,
    }));
  }

  describe("a first sync", () => {
    it("creates the season, 23 events and their sessions", async () => {
      const report = await sync(loadCalendar2026());

      expect(report).toEqual({
        created: 23,
        updated: 0,
        unchanged: 0,
        reviewItems: 0,
        changed: 23,
      });
      const [season] = await t.db.select().from(seasons);
      expect(season).toMatchObject({ year: 2026, status: "upcoming" });
      expect(await allEvents()).toHaveLength(23);
      expect(await t.db.select().from(sessions)).toHaveLength(23 * 5);
      expect(await t.db.select().from(circuits)).toHaveLength(23);
    });

    it("builds slugs from the event name and the circuit id", async () => {
      await sync(loadCalendar2026());

      const china = await eventByName("Chinese Grand Prix");
      expect(china.slug).toBe("2026-chinese-grand-prix");
      const [ring] = await t.db
        .select()
        .from(circuits)
        .where(eq(circuits.slug, "red-bull-ring"));
      expect(ring).toMatchObject({
        name: "Red Bull Ring",
        timezone: "Europe/Vienna",
      });
    });

    it("derives scheduled_end from the session_durations setting", async () => {
      await sync(loadCalendar2026());

      const china = await eventByName("Chinese Grand Prix");
      const byKind = new Map(
        (await sessionsOf(china.id)).map((s) => [s.kind, s]),
      );
      const minutes = (kind: string) => {
        const s = byKind.get(kind as "race")!;
        return (s.scheduledEnd.getTime() - s.scheduledStart.getTime()) / MINUTE;
      };
      expect(minutes("fp1")).toBe(60);
      expect(minutes("sprint_qualifying")).toBe(45);
      expect(minutes("sprint")).toBe(45);
      expect(minutes("qualifying")).toBe(60);
      expect(minutes("race")).toBe(120);
      for (const s of byKind.values()) {
        expect(s).toMatchObject({
          timeSource: "provider",
          startConfirmed: true,
          status: "scheduled",
          sequence: 1,
        });
      }
    });

    it("locks on Qualifying, and on Sprint Qualifying for sprint weekends", async () => {
      await sync(loadCalendar2026());

      for (const [name, kind] of [
        ["Australian Grand Prix", "qualifying"],
        ["Chinese Grand Prix", "sprint_qualifying"],
      ] as const) {
        const event = await eventByName(name);
        const lock = (await sessionsOf(event.id)).find(
          (s) => s.id === event.lockSessionId,
        );
        expect(lock?.kind).toBe(kind);
        expect(event.lockAt).toEqual(lock!.scheduledStart);
        expect(event.lockAtSource).toBe("default");
        expect(event.status).toBe("scheduled");
      }
      const china = await eventByName("Chinese Grand Prix");
      expect(china.format).toBe("sprint");
      expect(china.lockAt).toEqual(new Date("2026-03-13T07:30:00Z"));
    });

    it("writes provider ids for events and circuits", async () => {
      await sync(loadCalendar2026());

      const rows = await t.db.select().from(providerIds);
      expect(rows.filter((r) => r.entityType === "event")).toHaveLength(23);
      expect(rows.filter((r) => r.entityType === "circuit")).toHaveLength(23);
      expect(new Set(rows.map((r) => r.provider))).toEqual(
        new Set(["jolpica"]),
      );
      const china = await eventByName("Chinese Grand Prix");
      expect((await eventKeys()).get(china.id)).toBe("2026/2");
    });

    it("stamps rows with the passed clock", async () => {
      await sync(loadCalendar2026());
      const [event] = await allEvents();
      expect(event!.createdAt).toEqual(new Date("2026-02-01T00:00:00.000Z"));
      expect(event!.updatedAt).toEqual(new Date("2026-02-01T00:00:00.000Z"));
    });

    it("stores a date-only session as not confirmed", async () => {
      const list = loadCalendar2026();
      list[0]!.sessions = list[0]!.sessions.map((s) =>
        s.kind === "qualifying"
          ? { ...s, start: new Date("2026-03-07T00:00:00Z"), confirmed: false }
          : s,
      );
      await sync(list);

      const event = await eventByName("Australian Grand Prix");
      const q = (await sessionsOf(event.id)).find(
        (s) => s.kind === "qualifying",
      )!;
      expect(q.startConfirmed).toBe(false);
    });
  });

  describe("syncing again", () => {
    it("changes nothing", async () => {
      await sync(loadCalendar2026());
      const before = await allEvents();
      const beforeSessions = await t.db.select().from(sessions);
      clock.advance(60 * MINUTE);

      const report = await sync(loadCalendar2026());

      expect(report).toEqual({
        created: 0,
        updated: 0,
        unchanged: 23,
        reviewItems: 0,
        changed: 0,
      });
      expect(await allEvents()).toEqual(before);
      expect(await t.db.select().from(sessions)).toHaveLength(
        beforeSessions.length,
      );
      expect(await reviews()).toEqual([]);
    });

    it("adds a new event and leaves the rest", async () => {
      const list = loadCalendar2026();
      const extra = list.pop()!;
      await sync(list);

      const report = await sync([...list, extra]);

      expect(report).toMatchObject({ created: 1, updated: 0, unchanged: 22 });
      expect(await allEvents()).toHaveLength(23);
    });

    it("updates a session that moved, and the lock follows it", async () => {
      await sync(loadCalendar2026());
      const list = loadCalendar2026();
      const moved = list[0]!.sessions.find((s) => s.kind === "qualifying")!;
      moved.start = new Date(moved.start.getTime() + 60 * MINUTE);

      const report = await sync(list);

      expect(report).toMatchObject({ updated: 1, unchanged: 22 });
      const event = await eventByName("Australian Grand Prix");
      const q = (await sessionsOf(event.id)).find(
        (s) => s.kind === "qualifying",
      )!;
      expect(q.scheduledStart).toEqual(moved.start);
      expect(q.scheduledEnd).toEqual(
        new Date(moved.start.getTime() + 60 * MINUTE),
      );
      expect(event.lockAt).toEqual(moved.start);
    });
  });

  describe("a renumbered calendar", () => {
    it("changes only round and the provider key when Miami moves from round 4 to 6", async () => {
      await sync(loadCalendar2026());
      const before = new Map((await allEvents()).map((e) => [e.id, e]));
      const beforeSessions = await t.db.select().from(sessions);
      const miami = await eventByName("Miami Grand Prix");
      expect(miami.round).toBe(4);
      clock.advance(MINUTE);

      const report = await sync(
        moveEvent(loadCalendar2026(), "Miami Grand Prix", 6),
      );

      // Miami 4 -> 6, Canada 5 -> 4, Monaco 6 -> 5.
      expect(report).toEqual({
        created: 0,
        updated: 3,
        unchanged: 20,
        reviewItems: 0,
        changed: 3,
      });
      const after = await allEvents();
      expect(after).toHaveLength(23);
      for (const event of after) {
        const old = before.get(event.id)!;
        expect({ ...event, round: 0, updatedAt: null }).toEqual({
          ...old,
          round: 0,
          updatedAt: null,
        });
      }
      expect((await eventByName("Miami Grand Prix")).round).toBe(6);
      expect((await eventByName("Canadian Grand Prix")).round).toBe(4);
      expect((await eventByName("Monaco Grand Prix")).round).toBe(5);
      // Sessions are untouched.
      expect(await t.db.select().from(sessions)).toEqual(beforeSessions);
      // The provider keys followed the renumbering.
      const keys = await eventKeys();
      expect(keys.get(miami.id)).toBe("2026/6");
      expect(keys.get((await eventByName("Canadian Grand Prix")).id)).toBe(
        "2026/4",
      );
      expect(new Set(keys.values()).size).toBe(23);
    });

    it("keeps a cancelled event's row and moves its round out of the way", async () => {
      const original = loadCalendar2026();
      await sync(original);
      const monaco = await eventByName("Monaco Grand Prix");
      expect(monaco.round).toBe(6);

      // Monaco leaves the feed and every later round is renumbered.
      const next = original
        .filter((e) => e.name !== "Monaco Grand Prix")
        .map((e, i) => ({ ...e, round: i + 1, key: `2026/${i + 1}` }));
      const report = await sync(next);

      expect(report).toMatchObject({ created: 0, reviewItems: 1 });
      const rows = await allEvents();
      expect(rows).toHaveLength(23);
      const kept = rows.find((e) => e.id === monaco.id)!;
      expect(kept).toMatchObject({
        name: "Monaco Grand Prix",
        status: "scheduled",
      });
      expect(new Set(rows.map((e) => e.round)).size).toBe(23);
      expect((await eventByName("Barcelona Grand Prix")).round).toBe(6);
    });
  });

  describe("an event missing from the provider", () => {
    it("keeps the row and opens event_missing_from_provider once", async () => {
      const original = loadCalendar2026();
      await sync(original);
      const monaco = await eventByName("Monaco Grand Prix");
      const without = original.filter((e) => e.name !== "Monaco Grand Prix");

      const report = await sync(without);

      expect(report).toMatchObject({ created: 0, updated: 0, unchanged: 22 });
      expect(report.reviewItems).toBe(1);
      expect(await allEvents()).toHaveLength(23);
      expect((await eventByName("Monaco Grand Prix")).status).toBe("scheduled");
      const items = await reviews();
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        kind: "event_missing_from_provider",
        severity: "warning",
        status: "open",
        eventId: monaco.id,
        dedupeKey: `event_missing:${monaco.id}`,
      });

      // A repeat run does not pile up another one.
      const again = await sync(without);
      expect(again.reviewItems).toBe(0);
      expect(await reviews()).toHaveLength(1);
    });

    it("does not flag a cancelled event", async () => {
      const original = loadCalendar2026();
      await sync(original);
      const monaco = await eventByName("Monaco Grand Prix");
      await t.db
        .update(events)
        .set({ status: "cancelled" })
        .where(eq(events.id, monaco.id));

      const report = await sync(
        original.filter((e) => e.name !== "Monaco Grand Prix"),
      );

      expect(report.reviewItems).toBe(0);
    });
  });

  describe("a session missing from the provider", () => {
    it("keeps the session and opens session_missing_from_provider once", async () => {
      await sync(loadCalendar2026());
      const event = await eventByName("Australian Grand Prix");
      const fp3 = (await sessionsOf(event.id)).find((s) => s.kind === "fp3")!;
      const beforeSessions = await t.db.select().from(sessions);
      const list = loadCalendar2026();
      list[0]!.sessions = list[0]!.sessions.filter((s) => s.kind !== "fp3");

      const report = await sync(list);

      expect(report).toEqual({
        created: 0,
        updated: 0,
        unchanged: 23,
        reviewItems: 1,
        changed: 0,
      });
      expect(await t.db.select().from(sessions)).toEqual(beforeSessions);
      const items = await reviews();
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        kind: "session_missing_from_provider",
        severity: "warning",
        status: "open",
        eventId: event.id,
        sessionId: fp3.id,
        dedupeKey: `session_missing:${fp3.id}`,
      });

      expect((await sync(list)).reviewItems).toBe(0);
      expect(await reviews()).toHaveLength(1);
    });

    it("does not flag a cancelled session", async () => {
      await sync(loadCalendar2026());
      const event = await eventByName("Australian Grand Prix");
      await t.db
        .update(sessions)
        .set({ status: "cancelled" })
        .where(and(eq(sessions.eventId, event.id), eq(sessions.kind, "fp3")));
      const list = loadCalendar2026();
      list[0]!.sessions = list[0]!.sessions.filter((s) => s.kind !== "fp3");

      expect((await sync(list)).reviewItems).toBe(0);
    });
  });

  describe("an admin lock when the lock session changes", () => {
    it("keeps the admin's lock_at, moves the link and opens lock_session_changed", async () => {
      await sync(loadCalendar2026());
      const event = await eventByName("Chinese Grand Prix");
      const rows = await sessionsOf(event.id);
      const sprintQuali = rows.find((s) => s.kind === "sprint_qualifying")!;
      const quali = rows.find((s) => s.kind === "qualifying")!;
      expect(event.lockSessionId).toBe(sprintQuali.id);
      const adminLock = new Date("2026-03-13T06:00:00Z");
      await t.db
        .update(events)
        .set({ lockAt: adminLock, lockAtSource: "admin" })
        .where(eq(events.id, event.id));

      // The format flips: the lock moves from sprint qualifying to qualifying.
      const list = loadCalendar2026();
      list.find((e) => e.name === "Chinese Grand Prix")!.format = "standard";
      const report = await sync(list);

      expect(report).toMatchObject({ updated: 1, reviewItems: 1 });
      const after = await eventByName("Chinese Grand Prix");
      expect(after.lockSessionId).toBe(quali.id);
      expect(after.lockAt).toEqual(adminLock);
      expect(after.lockAtSource).toBe("admin");
      const items = await reviews();
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        kind: "lock_session_changed",
        severity: "warning",
        eventId: event.id,
        dedupeKey: `lock_session_changed:${event.id}`,
      });
      expect(items[0]!.details).toMatchObject({
        from: sprintQuali.id,
        to: quali.id,
        lockAt: adminLock.toISOString(),
      });

      // Nothing more on a repeat run.
      const again = await sync(list);
      expect(again).toMatchObject({ changed: 0, reviewItems: 0 });
    });

    it("opens no item when the default lock follows a new lock session", async () => {
      await sync(loadCalendar2026());
      const list = loadCalendar2026();
      list.find((e) => e.name === "Chinese Grand Prix")!.format = "standard";

      const report = await sync(list);

      expect(report.reviewItems).toBe(0);
      const event = await eventByName("Chinese Grand Prix");
      const quali = (await sessionsOf(event.id)).find(
        (s) => s.kind === "qualifying",
      )!;
      expect(event.lockAt).toEqual(quali.scheduledStart);
    });
  });

  describe("an uncertain match (Review Focus 5)", () => {
    it("opens uncertain_event_match and changes nothing when name and circuit both change", async () => {
      await sync(loadCalendar2026());
      const before = await allEvents();
      const beforeSessions = await t.db.select().from(sessions);
      const beforeCircuits = await t.db.select().from(circuits);
      const beforeKeys = await eventKeys();

      const list = loadCalendar2026();
      const us = list.find((e) => e.name === "United States Grand Prix")!;
      us.name = "Austin Night Grand Prix";
      us.circuit = {
        ...us.circuit,
        key: "new_austin",
        name: "New Austin Circuit",
      };
      us.sessions = us.sessions.map((s) => ({
        ...s,
        start: new Date(s.start.getTime() + 60 * MINUTE),
      }));
      const report = await sync(list);

      expect(report).toEqual({
        created: 0,
        updated: 0,
        unchanged: 22,
        reviewItems: 1,
        changed: 0,
      });
      expect(await allEvents()).toEqual(before);
      expect(await t.db.select().from(sessions)).toEqual(beforeSessions);
      expect(await t.db.select().from(circuits)).toEqual(beforeCircuits);
      expect(await eventKeys()).toEqual(beforeKeys);
      const items = await reviews();
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({
        kind: "uncertain_event_match",
        status: "open",
        dedupeKey: "uncertain_match:2026:2026/18",
      });
      // The existing event is not also reported missing.
      expect(items.some((i) => i.kind === "event_missing_from_provider")).toBe(
        false,
      );

      // A repeat run does not duplicate it.
      const again = await sync(list);
      expect(again.reviewItems).toBe(0);
      expect(await reviews()).toHaveLength(1);
    });

    it("opens uncertain_event_match when the circuit changes under the same name and date", async () => {
      await sync(loadCalendar2026());
      const before = await allEvents();
      const list = loadCalendar2026();
      const spa = list.find((e) => e.name === "Belgian Grand Prix")!;
      spa.circuit = { ...spa.circuit, key: "elsewhere", name: "Elsewhere" };

      const report = await sync(list);

      expect(report).toMatchObject({ created: 0, updated: 0, reviewItems: 1 });
      expect(await allEvents()).toEqual(before);
      expect((await reviews())[0]!.details).toMatchObject({
        reason: "circuit_changed",
      });
    });

    it("opens uncertain_event_match when more than one event could match", async () => {
      const base = loadCalendar2026()[0]!;
      const twin = (key: string, day: string): CalendarEvent => ({
        ...base,
        key,
        raceDate: day,
        name: "Twin Grand Prix",
        sessions: base.sessions.map((s) => ({
          ...s,
          start: new Date(
            s.start.getTime() +
              (Date.parse(`${day}T00:00:00Z`) -
                Date.parse(`${base.raceDate}T00:00:00Z`)),
          ),
        })),
      });
      const first = twin("2026/1", "2026-03-08");
      const second = { ...twin("2026/2", "2026-03-10"), round: 2 };
      await sync([first, second]);
      expect(await allEvents()).toHaveLength(2);

      // One incoming event sits within three days of both.
      const report = await sync([
        { ...twin("2026/9", "2026-03-09"), round: 9 },
      ]);

      expect(report).toMatchObject({ created: 0, updated: 0, reviewItems: 1 });
      const items = (await reviews()).filter(
        (i) => i.kind === "uncertain_event_match",
      );
      expect(items).toHaveLength(1);
      expect(items[0]!.details).toMatchObject({ reason: "ambiguous" });
      expect(await allEvents()).toHaveLength(2);
    });
  });

  describe("admin-owned fields (Review Focus 2)", () => {
    it("skips a session time and lock_at set by an admin, and updates the rest", async () => {
      await sync(loadCalendar2026());
      const event = await eventByName("Australian Grand Prix");
      const rows = await sessionsOf(event.id);
      const qualifying = rows.find((s) => s.kind === "qualifying")!;
      const adminStart = new Date("2026-03-07T06:00:00Z");
      const adminEnd = new Date("2026-03-07T07:30:00Z");
      const adminLock = new Date("2026-03-07T05:30:00Z");
      await t.db
        .update(sessions)
        .set({
          scheduledStart: adminStart,
          scheduledEnd: adminEnd,
          timeSource: "admin",
        })
        .where(eq(sessions.id, qualifying.id));
      await t.db
        .update(events)
        .set({ lockAt: adminLock, lockAtSource: "admin" })
        .where(eq(events.id, event.id));

      // The provider moves every session of this event by an hour.
      const list = loadCalendar2026();
      for (const s of list[0]!.sessions) {
        s.start = new Date(s.start.getTime() + 60 * MINUTE);
      }
      const report = await sync(list);

      expect(report).toMatchObject({ updated: 1, unchanged: 22 });
      const after = await sessionsOf(event.id);
      const q = after.find((s) => s.kind === "qualifying")!;
      expect(q.scheduledStart).toEqual(adminStart);
      expect(q.scheduledEnd).toEqual(adminEnd);
      expect(q.timeSource).toBe("admin");
      const fp1 = after.find((s) => s.kind === "fp1")!;
      const oldFp1 = rows.find((s) => s.kind === "fp1")!;
      expect(fp1.scheduledStart).toEqual(
        new Date(oldFp1.scheduledStart.getTime() + 60 * MINUTE),
      );
      expect(fp1.scheduledEnd).toEqual(
        new Date(oldFp1.scheduledEnd.getTime() + 60 * MINUTE),
      );
      const race = after.find((s) => s.kind === "race")!;
      expect(race.scheduledStart).toEqual(
        new Date(
          rows.find((s) => s.kind === "race")!.scheduledStart.getTime() +
            60 * MINUTE,
        ),
      );
      const lockedEvent = await eventByName("Australian Grand Prix");
      expect(lockedEvent.lockAt).toEqual(adminLock);
      expect(lockedEvent.lockAtSource).toBe("admin");
      // The lock session link is still maintained.
      expect(lockedEvent.lockSessionId).toBe(qualifying.id);
    });

    it("leaves lock_at alone for an admin override even when its session is provider-timed", async () => {
      await sync(loadCalendar2026());
      const event = await eventByName("Belgian Grand Prix");
      const adminLock = new Date("2026-07-18T11:00:00Z");
      await t.db
        .update(events)
        .set({ lockAt: adminLock, lockAtSource: "admin" })
        .where(eq(events.id, event.id));
      const list = loadCalendar2026();
      const spa = list.find((e) => e.name === "Belgian Grand Prix")!;
      const q = spa.sessions.find((s) => s.kind === "qualifying")!;
      q.start = new Date(q.start.getTime() + 30 * MINUTE);

      await sync(list);

      expect((await eventByName("Belgian Grand Prix")).lockAt).toEqual(
        adminLock,
      );
      const row = (await sessionsOf(event.id)).find(
        (s) => s.kind === "qualifying",
      )!;
      expect(row.scheduledStart).toEqual(q.start);
    });
  });

  describe("circuits", () => {
    it("uses a placeholder timezone and opens a review item for an unknown one", async () => {
      const list = loadCalendar2026().slice(0, 2);
      list[0]!.circuit = {
        ...list[0]!.circuit,
        key: "new_street_circuit",
        timezone: null,
      };

      const report = await sync(list);

      expect(report.reviewItems).toBe(1);
      const [circuit] = await t.db
        .select()
        .from(circuits)
        .where(eq(circuits.slug, "new-street-circuit"));
      expect(circuit!.timezone).toBe("UTC");
      expect((await reviews())[0]).toMatchObject({
        kind: "circuit_timezone_missing",
        severity: "warning",
      });
    });

    it("never overwrites a circuit timezone an admin set", async () => {
      const list = loadCalendar2026().slice(0, 2);
      await sync(list);
      await t.db
        .update(circuits)
        .set({ timezone: "Australia/Sydney" })
        .where(eq(circuits.slug, "albert-park"));

      const report = await sync(list);

      expect(report.changed).toBe(0);
      const [circuit] = await t.db
        .select()
        .from(circuits)
        .where(eq(circuits.slug, "albert-park"));
      expect(circuit!.timezone).toBe("Australia/Sydney");
    });

    it("updates a circuit's descriptive fields when the provider changes them", async () => {
      await sync(loadCalendar2026());
      const list = loadCalendar2026();
      list[0]!.circuit = {
        ...list[0]!.circuit,
        name: "Albert Park Street Circuit",
      };

      const report = await sync(list);

      expect(report).toMatchObject({ updated: 1, unchanged: 22 });
      const [circuit] = await t.db
        .select()
        .from(circuits)
        .where(eq(circuits.slug, "albert-park"));
      expect(circuit!.name).toBe("Albert Park Street Circuit");
    });

    it("gives two events at one circuit one circuit row, and distinct event slugs", async () => {
      const [a, b] = loadCalendar2026();
      const second: CalendarEvent = {
        ...b!,
        circuit: a!.circuit,
        name: "Australian Grand Prix II",
      };
      await sync([a!, second]);

      expect(await t.db.select().from(circuits)).toHaveLength(1);
      const slugs = (await allEvents()).map((e) => e.slug);
      expect(slugs).toEqual([
        "2026-australian-grand-prix",
        "2026-australian-grand-prix-ii",
      ]);
    });

    it("suffixes a slug that clashes", async () => {
      const [a, b] = loadCalendar2026();
      // The same name on two keys, far apart, so they are two events.
      const second: CalendarEvent = {
        ...b!,
        name: a!.name,
      };
      await sync([a!, second]);

      const slugs = (await allEvents()).map((e) => e.slug).sort();
      expect(slugs).toEqual([
        "2026-australian-grand-prix",
        "2026-australian-grand-prix-2",
      ]);
    });
  });

  describe("failure", () => {
    it("leaves nothing behind when a write fails part way", async () => {
      const list = loadCalendar2026();
      // Two events with one round: the deferred unique fails at commit.
      list[5]!.round = list[4]!.round;

      await expect(sync(list)).rejects.toThrow();

      expect(await t.db.select().from(events)).toEqual([]);
      expect(await t.db.select().from(sessions)).toEqual([]);
      expect(await t.db.select().from(circuits)).toEqual([]);
      expect(await t.db.select().from(providerIds)).toEqual([]);
      expect(await t.db.select().from(reviewItems)).toEqual([]);
      expect(
        await t.db
          .select()
          .from(providerIds)
          .where(and(eq(providerIds.provider, "jolpica"))),
      ).toEqual([]);
    });
  });
});
