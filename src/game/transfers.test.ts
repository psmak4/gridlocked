import { describe, expect, it } from "vitest";
import { RULESET_2026 } from "./ruleset";
import {
  carryOverOut,
  freeTransfers,
  netTransfers,
  transferPenalty,
} from "./transfers";

// The transfer formulas of DM 3.8, pinned on the 2026 params: 2 free a week, 1
// carried at most, -10 for each one beyond, and 0 carried out of an unlimited
// week.

const PARAMS = RULESET_2026;
const BASE = ["a", "b", "c", "d", "e", "f", "g"];

describe("transfers (DM 3.8)", () => {
  it("a revert is free", () => {
    // Out and back in again: the lineup is the base, in another order.
    const locked = ["g", "f", "e", "d", "c", "b", "a"];
    expect(netTransfers(BASE, locked)).toBe(0);
    const free = freeTransfers(PARAMS, {
      isFirstEvent: false,
      carryIn: 0,
      unlimited: false,
    });
    expect(transferPenalty(PARAMS, { free, made: 0 })).toBe(0);
    expect(carryOverOut(PARAMS, { free, made: 0 })).toBe(1);
    // One real change is one transfer.
    expect(netTransfers(BASE, ["a", "b", "c", "d", "e", "f", "x"])).toBe(1);
  });

  it("a Boost-only swap is 0", () => {
    // The Boost is not an asset: moving it leaves the same ids.
    expect(netTransfers(BASE, [...BASE])).toBe(0);
  });

  it("two unused with one carried in carries only 1", () => {
    const free = freeTransfers(PARAMS, {
      isFirstEvent: false,
      carryIn: 1,
      unlimited: false,
    });
    expect(free).toBe(3);
    expect(carryOverOut(PARAMS, { free, made: 1 })).toBe(1);
    // Using them all, or more, carries nothing.
    expect(carryOverOut(PARAMS, { free, made: 3 })).toBe(0);
    expect(carryOverOut(PARAMS, { free, made: 5 })).toBe(0);
  });

  it("three made with two free costs -10", () => {
    const free = freeTransfers(PARAMS, {
      isFirstEvent: false,
      carryIn: 0,
      unlimited: false,
    });
    expect(free).toBe(2);
    expect(transferPenalty(PARAMS, { free, made: 3 })).toBe(-10);
    expect(transferPenalty(PARAMS, { free, made: 2 })).toBe(0);
    expect(transferPenalty(PARAMS, { free, made: 5 })).toBe(-30);
  });

  it("an unlimited week has no penalty and carries 0", () => {
    for (const week of [
      { isFirstEvent: true, carryIn: 0, unlimited: false },
      { isFirstEvent: false, carryIn: 1, unlimited: true },
    ]) {
      const free = freeTransfers(PARAMS, week);
      expect(free).toBeNull();
      expect(transferPenalty(PARAMS, { free, made: 7 })).toBe(0);
      expect(carryOverOut(PARAMS, { free, made: 0 })).toBe(0);
    }
    // The carry out of an unlimited week is the param, not a constant.
    const one = {
      ...PARAMS,
      transfers: { ...PARAMS.transfers, carryOverOutInUnlimitedWeek: 1 },
    };
    expect(carryOverOut(one, { free: null, made: 0 })).toBe(1);
  });
});
