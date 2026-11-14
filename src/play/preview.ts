import type { LineupPick } from "@/game/lineups";
import { netTransfers, transferPenalty } from "@/game/transfers";
import type { MoneyUnits } from "@/lib/money";
import type { BuilderState } from "./builder";

export type TeamProblem =
  | "drivers"
  | "constructors"
  | "boost"
  | "over_budget"
  | "x3_target"
  | "unavailable";

/** What a lineup would cost and count if saved now (the builder's footer). */
export type TeamPreview = {
  spent: MoneyUnits;
  /** How far over the purchasing power; 0 when within it. */
  overBy: MoneyUnits;
  /** Assets not in the base, counted net as the lock job counts them. */
  transfers: number;
  /** The free transfers this event; null is unlimited. */
  free: number | null;
  /** Transfers beyond the free ones. */
  extra: number;
  /** Points, zero or less. */
  penalty: number;
  problems: TeamProblem[];
};

/**
 * Previews `picks` against the builder's state, with no database: the
 * transfer count and penalty come from `netTransfers` and `transferPenalty`,
 * so they are the numbers the lock job writes. With Blank Cheque played
 * (`limitless`) nothing is over budget. Problems are what the save would
 * refuse, in a fixed order; "out" and "doubtful" are warnings, not problems.
 */
export function previewTeam(
  state: BuilderState,
  picks: LineupPick[],
): TeamPreview {
  const rows = new Map(state.pool.map((row) => [row.assetId, row]));
  const picked = picks.map((pick) => ({ pick, row: rows.get(pick.assetId) }));

  const spent = picked.reduce((sum, { row }) => sum + (row?.price ?? 0), 0);
  const overBy = state.limitless
    ? 0
    : Math.max(0, spent - state.purchasingPower);

  const transfers = netTransfers(
    (state.base ?? []).map((p) => p.assetId),
    picks.map((p) => p.assetId),
  );
  const free = state.freeTransfers;
  const extra = free === null ? 0 : Math.max(0, transfers - free);
  const penalty = transferPenalty(
    {
      transfers: {
        freePerEvent: 0,
        carryOverMax: 0,
        carryOverOutInUnlimitedWeek: 0,
        penalty: state.penaltyPerTransfer,
      },
    },
    { free, made: transfers },
  );

  const drivers = picked.filter(({ row }) => row?.kind === "driver");
  const constructors = picked.filter(({ row }) => row?.kind === "constructor");
  const boosts = picked.filter(({ pick }) => pick.isBoost);

  const problems: TeamProblem[] = [];
  if (drivers.length !== state.squad.drivers) problems.push("drivers");
  if (constructors.length !== state.squad.constructors) {
    problems.push("constructors");
  }
  if (
    boosts.length !== state.squad.boosts ||
    boosts.some(({ row }) => row?.kind !== "driver")
  ) {
    problems.push("boost");
  }
  if (overBy > 0) problems.push("over_budget");
  if (state.x3TargetAssetId !== null) {
    const target = picks.find((p) => p.assetId === state.x3TargetAssetId);
    if (!target || target.isBoost) problems.push("x3_target");
  }
  if (
    picked.some(
      ({ row }) => !row || (row.availability === "withdrawn" && !row.inBase),
    )
  ) {
    problems.push("unavailable");
  }

  return { spent, overBy, transfers, free, extra, penalty, problems };
}
