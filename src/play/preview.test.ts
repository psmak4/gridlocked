import { describe, expect, it } from "vitest";
import type { LineupPick } from "@/game/lineups";
import type { BuilderState, PoolRow } from "./builder";
import { previewTeam } from "./preview";

// Pure: a hand-made builder state. Money is in $0.1M (DM 0.3).

const driver = (id: string, price: number): PoolRow => ({
  assetId: id,
  kind: "driver",
  title: id,
  subtitle: "",
  code: id.toUpperCase(),
  color: "#000000",
  price,
  delta: null,
  availability: "available",
  inBase: false,
  ownership: null,
});
const team = (id: string, price: number): PoolRow => ({
  ...driver(id, price),
  kind: "constructor",
});

const POOL: PoolRow[] = [
  driver("d1", 300),
  driver("d2", 200),
  driver("d3", 150),
  driver("d4", 100),
  driver("d5", 64),
  driver("d6", 80),
  driver("d7", 60),
  team("c1", 100),
  team("c2", 100),
  team("c3", 90),
];

/** d1–d5 and c1–c2, the Boost on d1: $101.4M. */
const LINEUP: LineupPick[] = [
  { assetId: "d1", isBoost: true },
  { assetId: "d2", isBoost: false },
  { assetId: "d3", isBoost: false },
  { assetId: "d4", isBoost: false },
  { assetId: "d5", isBoost: false },
  { assetId: "c1", isBoost: false },
  { assetId: "c2", isBoost: false },
];

function state(over: Partial<BuilderState> = {}): BuilderState {
  return {
    team: { id: "t1", slot: 1, name: "Team" },
    event: null,
    phase: "open",
    pool: POOL,
    latest: null,
    base: null,
    purchasingPower: 1100,
    freeTransfers: null,
    penaltyPerTransfer: -10,
    squad: { drivers: 5, constructors: 2, boosts: 1 },
    chips: [],
    limitless: false,
    x3TargetAssetId: null,
    lateCallOpen: false,
    locked: null,
    ...over,
  };
}

/** `LINEUP` with `out` swapped for `into`, the Boost staying where it was. */
function swap(
  picks: LineupPick[],
  pairs: Array<[out: string, into: string]>,
): LineupPick[] {
  return picks.map((p) => {
    const pair = pairs.find(([out]) => out === p.assetId);
    return pair ? { ...p, assetId: pair[1] } : p;
  });
}

describe("previewTeam", () => {
  it("a first event has unlimited free transfers and no penalty", () => {
    const preview = previewTeam(state(), LINEUP);
    expect(preview).toMatchObject({
      transfers: 7,
      free: null,
      extra: 0,
      penalty: 0,
      problems: [],
    });
  });

  it("three changes with two free cost one extra transfer", () => {
    const picks = swap(LINEUP, [
      ["d3", "d6"],
      ["d4", "d7"],
      ["c2", "c3"],
    ]);
    const preview = previewTeam(
      state({ base: LINEUP, freeTransfers: 2 }),
      picks,
    );
    expect(preview).toMatchObject({
      transfers: 3,
      free: 2,
      extra: 1,
      penalty: -10,
    });
  });

  it("with one carried over, three changes are free", () => {
    const picks = swap(LINEUP, [
      ["d3", "d6"],
      ["d4", "d7"],
      ["c2", "c3"],
    ]);
    expect(
      previewTeam(state({ base: LINEUP, freeTransfers: 3 }), picks),
    ).toMatchObject({ transfers: 3, free: 3, extra: 0, penalty: 0 });
  });

  it("swapping a driver out and back in is no transfer", () => {
    // The Boost moves too: that isn't a transfer either.
    const picks = LINEUP.map((p) => ({ ...p, isBoost: p.assetId === "d2" }));
    expect(
      previewTeam(state({ base: LINEUP, freeTransfers: 2 }), picks),
    ).toMatchObject({ transfers: 0, extra: 0, penalty: 0, problems: [] });
  });

  it("$101.4M against $100M is over by $1.4M", () => {
    const preview = previewTeam(state({ purchasingPower: 1000 }), LINEUP);
    expect(preview.spent).toBe(1014);
    expect(preview.overBy).toBe(14);
    expect(preview.problems).toEqual(["over_budget"]);
  });

  it("a Blank Cheque week is never over budget", () => {
    const preview = previewTeam(
      state({ purchasingPower: 500, limitless: true, base: LINEUP }),
      LINEUP,
    );
    expect(preview.spent).toBe(1014);
    expect(preview.overBy).toBe(0);
    expect(preview.problems).toEqual([]);
  });

  it("four drivers is a drivers problem", () => {
    const picks = LINEUP.filter((p) => p.assetId !== "d5");
    expect(previewTeam(state(), picks).problems).toEqual(["drivers"]);
  });

  it("no Boost or two Boosts is a boost problem", () => {
    const none = LINEUP.map((p) => ({ ...p, isBoost: false }));
    expect(previewTeam(state(), none).problems).toEqual(["boost"]);
    const two = LINEUP.map((p) => ({
      ...p,
      isBoost: p.assetId === "d1" || p.assetId === "d2",
    }));
    expect(previewTeam(state(), two).problems).toEqual(["boost"]);
  });

  it("a Boost on a constructor is a boost problem", () => {
    const picks = LINEUP.map((p) => ({ ...p, isBoost: p.assetId === "c1" }));
    expect(previewTeam(state(), picks).problems).toEqual(["boost"]);
  });

  it("dropping the Overdrive target is an x3_target problem", () => {
    const withTarget = state({ x3TargetAssetId: "d3" });
    expect(previewTeam(withTarget, LINEUP).problems).toEqual([]);
    expect(
      previewTeam(withTarget, swap(LINEUP, [["d3", "d6"]])).problems,
    ).toEqual(["x3_target"]);
    // Nor may the 2x Boost sit on it.
    const boosted = LINEUP.map((p) => ({ ...p, isBoost: p.assetId === "d3" }));
    expect(previewTeam(withTarget, boosted).problems).toEqual(["x3_target"]);
  });

  it("a withdrawn asset is unavailable unless the team owns it", () => {
    const withdrawn = POOL.map((row) =>
      row.assetId === "d6"
        ? { ...row, availability: "withdrawn" as const }
        : row,
    );
    const picks = swap(LINEUP, [["d5", "d6"]]);
    expect(previewTeam(state({ pool: withdrawn }), picks).problems).toEqual([
      "unavailable",
    ]);
    const owned = withdrawn.map((row) =>
      row.assetId === "d6" ? { ...row, inBase: true } : row,
    );
    expect(previewTeam(state({ pool: owned }), picks).problems).toEqual([]);
    // An asset that isn't in the pool at all.
    expect(
      previewTeam(state(), swap(LINEUP, [["d5", "nobody"]])).problems,
    ).toEqual(["drivers", "unavailable"]);
  });
});
