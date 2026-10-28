import { describe, expect, it } from "vitest";
import { readFixture } from "../../../tests/helpers/fixtures";
import { parseJolpicaCalendar } from "./calendar";

const body = () => readFixture("jolpica/2026.json");

describe("parseJolpicaCalendar", () => {
  it("parses the 2026 calendar into our own shape", () => {
    const events = parseJolpicaCalendar(body());

    expect(events).toHaveLength(23);
    expect(events.map((e) => e.round)).toEqual(
      Array.from({ length: 23 }, (_, i) => i + 1),
    );

    const [australia] = events;
    expect(australia).toMatchObject({
      key: "2026/1",
      round: 1,
      name: "Australian Grand Prix",
      raceDate: "2026-03-08",
      format: "standard",
      circuit: {
        key: "albert_park",
        locality: "Melbourne",
        country: "Australia",
        timezone: "Australia/Melbourne",
      },
    });
    expect(australia!.sessions.map((s) => s.kind)).toEqual([
      "fp1",
      "fp2",
      "fp3",
      "qualifying",
      "race",
    ]);
    expect(australia!.sessions[0]).toEqual({
      kind: "fp1",
      start: new Date("2026-03-06T01:30:00Z"),
      confirmed: true,
    });
    expect(australia!.sessions.at(-1)).toEqual({
      kind: "race",
      start: new Date("2026-03-08T04:00:00Z"),
      confirmed: true,
    });
  });

  it("marks sprint weekends and keeps their session kinds in time order", () => {
    const events = parseJolpicaCalendar(body());
    const china = events.find((e) => e.name === "Chinese Grand Prix")!;

    expect(china.format).toBe("sprint");
    expect(china.sessions.map((s) => s.kind)).toEqual([
      "fp1",
      "sprint_qualifying",
      "sprint",
      "qualifying",
      "race",
    ]);
    expect(events.filter((e) => e.format === "sprint")).toHaveLength(6);
  });

  it("knows a timezone for every 2026 circuit", () => {
    const events = parseJolpicaCalendar(body());
    expect(events.filter((e) => e.circuit.timezone === null)).toEqual([]);
  });

  it("keeps a decimal string for coordinates", () => {
    const [australia] = parseJolpicaCalendar(body());
    expect(typeof australia!.circuit.latitude).toBe("string");
    expect(Number(australia!.circuit.latitude)).toBeCloseTo(-37.8497, 3);
  });

  it("treats a session with only a date as unconfirmed", () => {
    const raw = structuredClone(body()) as {
      MRData: { RaceTable: { Races: Array<Record<string, unknown>> } };
    };
    const race = raw.MRData.RaceTable.Races[0]!;
    race.Qualifying = { date: "2026-03-07" };
    delete race.time;

    const [event] = parseJolpicaCalendar(raw);
    const qualifying = event!.sessions.find((s) => s.kind === "qualifying")!;
    const raceSession = event!.sessions.find((s) => s.kind === "race")!;
    expect(qualifying).toEqual({
      kind: "qualifying",
      start: new Date("2026-03-07T00:00:00Z"),
      confirmed: false,
    });
    expect(raceSession.confirmed).toBe(false);
    // The other sessions still have their times.
    expect(event!.sessions.find((s) => s.kind === "fp1")!.confirmed).toBe(true);
  });

  it("gives an unknown circuit a null timezone", () => {
    const raw = structuredClone(body()) as {
      MRData: {
        RaceTable: { Races: Array<{ Circuit: { circuitId: string } }> };
      };
    };
    raw.MRData.RaceTable.Races[0]!.Circuit.circuitId = "new_street_circuit";

    const [event] = parseJolpicaCalendar(raw);
    expect(event!.circuit.key).toBe("new_street_circuit");
    expect(event!.circuit.timezone).toBeNull();
  });

  it("rejects a response that is not a calendar", () => {
    expect(() => parseJolpicaCalendar({})).toThrow();
    expect(() => parseJolpicaCalendar(null)).toThrow();
  });

  it("rejects a race with no race date", () => {
    const raw = structuredClone(body()) as {
      MRData: { RaceTable: { Races: Array<Record<string, unknown>> } };
    };
    delete raw.MRData.RaceTable.Races[3]!.date;
    expect(() => parseJolpicaCalendar(raw)).toThrow();
  });

  it("rejects a session block with an unreadable date", () => {
    const raw = structuredClone(body()) as {
      MRData: { RaceTable: { Races: Array<Record<string, unknown>> } };
    };
    raw.MRData.RaceTable.Races[0]!.Qualifying = { date: "soon" };
    expect(() => parseJolpicaCalendar(raw)).toThrow();
  });
});
