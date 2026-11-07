import { describe, expect, it } from "vitest";
import { rangeAfterRenumber, type PlannedEvent } from "./ranges";

// Events a to e held sequences 1 to 5 before planning.
const BEFORE = new Map([
  [1, "a"],
  [2, "b"],
  [3, "c"],
  [4, "d"],
  [5, "e"],
]);
const order = (...cancelled: string[]): PlannedEvent[] => {
  let next = 0;
  return ["a", "b", "c", "d", "e"].map((eventId) => ({
    eventId,
    sequence: cancelled.includes(eventId) ? null : ++next,
  }));
};

describe("rangeAfterRenumber", () => {
  it("changes nothing when nothing moved", () => {
    expect(rangeAfterRenumber({ start: 2, end: 4 }, BEFORE, order())).toEqual({
      start: 2,
      end: 4,
    });
  });

  it("follows the events down when an earlier one is cancelled", () => {
    expect(
      rangeAfterRenumber({ start: 3, end: 4 }, BEFORE, order("b")),
    ).toEqual({ start: 2, end: 3 });
  });

  it("follows the events up when an earlier one is added", () => {
    const planned = [
      { eventId: "new", sequence: 1 },
      ...["a", "b", "c", "d", "e"].map((eventId, i) => ({
        eventId,
        sequence: i + 2,
      })),
    ];
    expect(rangeAfterRenumber({ start: 2, end: 3 }, BEFORE, planned)).toEqual({
      start: 3,
      end: 4,
    });
  });

  it("skips a run of cancelled events at either end", () => {
    expect(
      rangeAfterRenumber({ start: 2, end: 4 }, BEFORE, order("b", "d")),
    ).toEqual({ start: 2, end: 2 });
  });

  it("keeps an end of null", () => {
    expect(
      rangeAfterRenumber({ start: 3, end: null }, BEFORE, order("a")),
    ).toEqual({ start: 2, end: null });
  });

  it("moves a range left with no events to the next race", () => {
    expect(
      rangeAfterRenumber({ start: 2, end: 3 }, BEFORE, order("b", "c")),
    ).toEqual({ start: 2, end: 2 });
  });

  it("stays on the last race when nothing comes after", () => {
    expect(
      rangeAfterRenumber({ start: 5, end: 5 }, BEFORE, order("e")),
    ).toEqual({ start: 4, end: 4 });
  });

  it("leaves a sequence past the season alone", () => {
    expect(
      rangeAfterRenumber({ start: 7, end: 9 }, BEFORE, order("b")),
    ).toEqual({ start: 7, end: 9 });
  });
});
