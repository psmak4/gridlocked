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

describe("tests/fixtures/seats-2026.json", () => {
  it.each(["01", "12", "13", "14"])(
    "matches the recorded round %s results",
    (round) => {
      const results = triples(round);
      expect(seatsOn(results.date)).toEqual(results.set);
    },
  );

  it("has 24 seats: 22 from round 1 and the two the Dutch GP swap opens", () => {
    expect(seats).toHaveLength(24);
    expect(seats.every((s) => s.role === "race")).toBe(true);
  });
});
