import { describe, expect, it } from "vitest";
import { revealOf, SHOW_ALL, withRevealed } from "./shown-ids";

const A = "0192f5a0-0000-7000-8000-000000000001";
const B = "0192f5a0-0000-7000-8000-000000000002";

describe("what a page revealed", () => {
  it("is kept in the history entry's state, not the address", () => {
    expect(revealOf({ shown: [A] })).toEqual({ ids: [A], all: false });
    expect(revealOf({})).toEqual({ ids: [], all: false });
    expect(revealOf(undefined)).toEqual({ ids: [], all: false });
    // Anything else in state is ignored.
    expect(revealOf({ shown: [A, "nope", 3] })).toEqual({
      ids: [A],
      all: false,
    });
    expect(revealOf({ shown: [SHOW_ALL] })).toEqual({ ids: [], all: true });
  });

  it("an old ?show= link reveals once and leaves the address without it", () => {
    // Read with the state on the first load…
    expect(revealOf({}, `${A},${B}`)).toEqual({ ids: [A, B], all: false });
    expect(revealOf({}, SHOW_ALL)).toEqual({ ids: [], all: true });
    // …and moved into it, so the address can drop it.
    expect(withRevealed({ shown: [A] }, revealOf({}, B))).toEqual({
      shown: [A, B],
    });
  });

  it("Show it adds to what's there, ten at most", () => {
    const many = Array.from(
      { length: 12 },
      (_, i) => `0192f5a0-0000-7000-8000-${String(i).padStart(12, "0")}`,
    );
    const state = withRevealed({ other: 1 }, { ids: many, all: false });
    expect(state.shown).toHaveLength(10);
    expect(state).toMatchObject({ other: 1 });
    expect(withRevealed({ shown: [A] }, { ids: [A], all: false })).toEqual({
      shown: [A],
    });
    expect(withRevealed({ shown: [A] }, { ids: [], all: true })).toEqual({
      shown: [SHOW_ALL],
    });
  });
});
