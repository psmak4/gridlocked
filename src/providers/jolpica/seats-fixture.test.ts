import { describe, expect, it } from "vitest";
import { readFixture } from "../../../tests/helpers/fixtures";

// tests/fixtures/seats-2026.json is derived from the recorded results. This
// keeps the two from drifting apart: the seats in force on a race date must
// be exactly the (driver, constructor, number) triples in that race's results.

interface Seat {
  driver: string;
  constructor: string;
  carNumber: number;
  role: string;
  validFrom: string;
  validTo: string | null;
}

interface ResultsBody {
  MRData: {
    RaceTable: {
      Races: Array<{
        date: string;
        Results: Array<{
          number: string;
          Driver: { driverId: string };
          Constructor: { constructorId: string };
        }>;
      }>;
    };
  };
}

const seats = (readFixture("seats-2026.json") as { seats: Seat[] }).seats;

function triples(round: string) {
  const [race] = (
    readFixture(`jolpica/2026/r${round}-results.json`) as ResultsBody
  ).MRData.RaceTable.Races;
  return {
    date: race!.date,
    set: new Set(
      race!.Results.map(
        (r) =>
          `${r.Driver.driverId}|${r.Constructor.constructorId}|${r.number}`,
      ),
    ),
  };
}

function seatsOn(date: string) {
  return new Set(
    seats
      .filter(
        (s) =>
          s.role === "race" &&
          s.validFrom <= date &&
          (s.validTo === null || s.validTo >= date),
      )
      .map((s) => `${s.driver}|${s.constructor}|${s.carNumber}`),
  );
}

const RECORDED_ROUNDS = ["01", "12", "13", "14", "15", "16", "17", "18"];

describe("tests/fixtures/seats-2026.json", () => {
  it.each(RECORDED_ROUNDS)(
    "matches the recorded round %s results exactly",
    (round) => {
      const results = triples(round);
      expect(seatsOn(results.date)).toEqual(results.set);
    },
  );

  it.each(RECORDED_ROUNDS)(
    "has an active race seat for every round %s result row",
    (round) => {
      const results = triples(round);
      const active = seatsOn(results.date);
      const unseated = [...results.set].filter((row) => !active.has(row));
      expect(unseated).toEqual([]);
    },
  );

  it("has 26 seats: 22 from round 1, two for the Dutch GP swap and two for its reversal", () => {
    expect(seats).toHaveLength(26);
    expect(seats.every((s) => s.role === "race")).toBe(true);
  });

  it("dates the reversal from the first session of round 15", () => {
    const hadjar = seats.filter((s) => s.driver === "hadjar");
    expect(hadjar.map((s) => [s.constructor, s.validFrom, s.validTo])).toEqual([
      ["red_bull", "2026-03-06", "2026-08-20"],
      ["red_bull", "2026-09-24", null],
    ]);
    const tsunoda = seats.filter((s) => s.driver === "tsunoda");
    expect(tsunoda.map((s) => [s.constructor, s.validFrom, s.validTo])).toEqual(
      [["rb", "2026-08-21", "2026-09-23"]],
    );
  });
});
