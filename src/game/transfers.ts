import type { RulesetParams } from "./ruleset";

// Transfer counting and carry-over (DM 3.8): pure functions of the ruleset's
// `transfers` params, which the lock job calls for each team. `null` free
// transfers is an unlimited week: the team's first event, or a chip week.

type TransferParams = Pick<RulesetParams, "transfers">;

/**
 * Transfers made: the assets in the locked lineup that aren't in the base.
 * Counted net, so an asset sold and bought back in one window is free, and
 * moving the Boost is not a transfer (it isn't an asset).
 */
export function netTransfers(
  baseAssetIds: string[],
  lockedAssetIds: string[],
): number {
  const base = new Set(baseAssetIds);
  return [...new Set(lockedAssetIds)].filter((id) => !base.has(id)).length;
}

/**
 * The allowance for an event: `freePerEvent` plus what carried in, or null
 * (unlimited) at the team's first event or in an unlimited chip week.
 */
export function freeTransfers(
  params: TransferParams,
  week: { isFirstEvent: boolean; carryIn: number; unlimited: boolean },
): number | null {
  if (week.isFirstEvent || week.unlimited) return null;
  return params.transfers.freePerEvent + week.carryIn;
}

/**
 * What carries into the next event: `carryOverOutInUnlimitedWeek` after an
 * unlimited week, otherwise the unused transfers, capped at `carryOverMax`, so
 * two unused don't become two carried.
 */
export function carryOverOut(
  params: TransferParams,
  week: { free: number | null; made: number },
): number {
  const { carryOverMax, carryOverOutInUnlimitedWeek } = params.transfers;
  if (week.free === null) return carryOverOutInUnlimitedWeek;
  return Math.min(carryOverMax, Math.max(0, week.free - week.made));
}

/**
 * Points for the transfers beyond the free ones, `penalty` (zero or less) for
 * each. None in an unlimited week.
 */
export function transferPenalty(
  params: TransferParams,
  week: { free: number | null; made: number },
): number {
  const extra = week.free === null ? 0 : week.made - week.free;
  // Not penalty x 0, which is -0.
  return extra > 0 ? params.transfers.penalty * extra : 0;
}
