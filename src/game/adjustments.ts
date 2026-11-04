import type { ChipEffect } from "./ruleset";

// Team adjustments (DM 4.3): what a team's points add to the sum of its assets'
// points. The Boost, the chips that change the score (Strategist, Overdrive,
// Safety Car) and the transfer penalty each become lines, so the explanation
// can show them. Pure: the caller (the scoring job) totals the assets' lines
// and passes them in, and stores the lines this returns.

/** A pick in a lineup. */
export interface TeamPick {
  assetId: string;
  assetType: "driver" | "constructor";
  isBoost: boolean;
}

/** An asset's points in one session: the total and the total by rule category. */
export interface AssetSessionPoints {
  total: number;
  byCategory: Record<string, number>;
}

export interface TeamEventInput {
  /** The event's sessions scored so far, in any order. */
  sessions: {
    sessionId: string;
    kind: "qualifying" | "sprint" | "race";
    order: number;
  }[];
  assetPoints: Map<string, Map<string, AssetSessionPoints>>;
  /** The lineup at the lock. */
  locked: TeamPick[];
  /** Late Call: the picks for the sessions from `fromSessionId` on. */
  finalFix: { picks: TeamPick[]; fromSessionId: string } | null;
  chip: { effect: ChipEffect; targetAssetId: string | null } | null;
  /** Zero or less, as `team_event_states.transfer_penalty` stores it. */
  transferPenalty: number;
  /** The event's prices, for Strategist's tiebreak. */
  prices: Map<string, number>;
}

export interface AdjustmentLine {
  sessionId: string | null;
  assetId: string | null;
  lineType:
    | "boost"
    | "triple_boost"
    | "autopilot_remove"
    | "autopilot_add"
    | "no_negative"
    | "transfer_penalty";
  category: string | null;
  points: number;
}

type LineupInput = Pick<TeamEventInput, "sessions" | "locked" | "finalFix">;

/**
 * The picks that score in a session: the Late Call picks from the session it
 * takes effect on (the race), the locked ones before it, and the locked ones
 * everywhere when there is no Late Call or its session isn't among those scored
 * yet. Task 4's view implements the same rule in SQL.
 */
export function effectiveLineup(
  input: LineupInput,
  sessionId: string,
): TeamPick[] {
  const { finalFix } = input;
  if (!finalFix) return input.locked;
  const order = (id: string) =>
    input.sessions.find((s) => s.sessionId === id)?.order;
  const from = order(finalFix.fromSessionId);
  const at = order(sessionId);
  if (from === undefined || at === undefined) return input.locked;
  return at >= from ? finalFix.picks : input.locked;
}

/**
 * The adjustment lines of one team for one event, in a fixed order: by session,
 * each with its Safety Car add-backs (by asset, then category), then the Boost,
 * then Overdrive; then the event-level Strategist pair and transfer penalty.
 * No line has 0 points.
 */
export function teamAdjustments(input: TeamEventInput): AdjustmentLine[] {
  const effect = input.chip?.effect ?? null;
  const sessions = [...input.sessions].sort((a, b) => a.order - b.order);
  const lines: AdjustmentLine[] = [];
  const push = (line: AdjustmentLine) => {
    if (line.points !== 0) lines.push(line);
  };

  const pointsOf = (sessionId: string, assetId: string) =>
    input.assetPoints.get(sessionId)?.get(assetId)?.total ?? 0;

  // The Boost lines of the original Boost driver, which Strategist takes back.
  const boostRemoved = new Map<string, number>();
  // Each driver's raw points in the sessions they were in the lineup.
  const driverEvent = new Map<string, number>();

  for (const { sessionId } of sessions) {
    const picks = effectiveLineup(input, sessionId);
    const perAsset = input.assetPoints.get(sessionId);

    // Safety Car: each negative category subtotal comes back to zero.
    const addBack = new Map<string, number>();
    if (effect === "no_negative") {
      const ids = picks.map((p) => p.assetId).sort(byText);
      for (const assetId of ids) {
        const byCategory = perAsset?.get(assetId)?.byCategory ?? {};
        for (const category of Object.keys(byCategory).sort(byText)) {
          const subtotal = byCategory[category]!;
          if (subtotal >= 0) continue;
          push({
            sessionId,
            assetId,
            lineType: "no_negative",
            category,
            points: -subtotal,
          });
          addBack.set(assetId, (addBack.get(assetId) ?? 0) - subtotal);
        }
      }
    }
    // The score the Boost doubles: floored with Safety Car, else the total.
    const scored = (assetId: string) =>
      pointsOf(sessionId, assetId) + (addBack.get(assetId) ?? 0);

    const boost = picks.find((p) => p.isBoost);
    if (boost) {
      const points = scored(boost.assetId);
      push({
        sessionId,
        assetId: boost.assetId,
        lineType: "boost",
        category: null,
        points,
      });
      boostRemoved.set(
        boost.assetId,
        (boostRemoved.get(boost.assetId) ?? 0) + points,
      );
    }

    const target = input.chip?.targetAssetId ?? null;
    if (
      effect === "triple_boost" &&
      target !== null &&
      picks.some((p) => p.assetId === target)
    ) {
      push({
        sessionId,
        assetId: target,
        lineType: "triple_boost",
        category: null,
        points: 2 * scored(target),
      });
    }

    for (const pick of picks) {
      if (pick.assetType !== "driver") continue;
      driverEvent.set(
        pick.assetId,
        (driverEvent.get(pick.assetId) ?? 0) +
          pointsOf(sessionId, pick.assetId),
      );
    }
  }

  const original = input.locked.find((p) => p.isBoost)?.assetId ?? null;
  if (effect === "autopilot" && original !== null) {
    const leader = strategistLeader(driverEvent, original, input.prices);
    if (leader !== null && leader !== original) {
      push({
        sessionId: null,
        assetId: original,
        lineType: "autopilot_remove",
        category: null,
        points: -(boostRemoved.get(original) ?? 0),
      });
      push({
        sessionId: null,
        assetId: leader,
        lineType: "autopilot_add",
        category: null,
        points: driverEvent.get(leader)!,
      });
    }
  }

  push({
    sessionId: null,
    assetId: null,
    lineType: "transfer_penalty",
    category: null,
    points: input.transferPenalty,
  });
  return lines;
}

/**
 * The driver with the most event points. A tie goes to the original Boost
 * driver if among them, else the higher price, else the lower asset id
 * (`original_then_price`, DM 3.9).
 */
function strategistLeader(
  eventPoints: Map<string, number>,
  original: string,
  prices: Map<string, number>,
): string | null {
  const price = (assetId: string) => prices.get(assetId) ?? 0;
  const ranked = [...eventPoints].sort(
    ([a, pa], [b, pb]) =>
      pb - pa ||
      Number(b === original) - Number(a === original) ||
      price(b) - price(a) ||
      byText(a, b),
  );
  return ranked[0]?.[0] ?? null;
}

function byText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
