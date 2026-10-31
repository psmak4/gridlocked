import { describe, expect, it } from "vitest";
import { absentEntrants, expectedCars } from "./expected-cars";

const entry = (driverId: string, constructorId: string) => ({
  driverId,
  constructorId,
});

// Haas at Mexico City 2026: Hirakawa entered alongside Ocon from FP3.
const entries = [
  entry("bearman", "haas"),
  entry("ocon", "haas"),
  entry("hirakawa", "haas"),
  entry("hamilton", "ferrari"),
  entry("leclerc", "ferrari"),
];

describe("expectedCars", () => {
  it("a team with three entries expects two cars", () => {
    expect(expectedCars(entries, 2)).toBe(4);
  });

  it("a team with one entry expects one car", () => {
    expect(expectedCars([entry("bearman", "haas")], 2)).toBe(1);
  });
});

describe("absentEntrants", () => {
  it("a full team has no absent entrants even when one of its three is absent", () => {
    const present = new Set(["bearman", "hirakawa", "hamilton", "leclerc"]);
    expect(absentEntrants(entries, present, 2)).toEqual([]);
  });

  it("a team with three entries and one car running lists both absent entrants", () => {
    const present = new Set(["bearman", "hamilton", "leclerc"]);
    expect(absentEntrants(entries, present, 2)).toEqual(["hirakawa", "ocon"]);
  });

  it("an absent driver of a two-car team is listed", () => {
    const present = new Set(["bearman", "ocon", "hirakawa", "hamilton"]);
    expect(absentEntrants(entries, present, 2)).toEqual(["leclerc"]);
  });
});
