import { and, asc, eq, inArray } from "drizzle-orm";
import {
  assetPrices,
  chipPlays,
  events,
  gameEvents,
  lineupPicks,
  lineupVersions,
  poolAssets,
  rulesetVersions,
  sessionResultState,
  sessions,
  teamEventStates,
  teams,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { rulesetParamsSchema } from "./ruleset";
import { transferPenalty } from "./transfers";

// The game's rules checked over what a season left behind (M3 Task 9), for
// the replay and for any game. Every lock record is worked out again here,
// in TypeScript, from the rows it was made from (versions, prices, chip
// plays), rather than by the SQL functions and the lock job that wrote it,
// so a mistake in those shows up as a difference. Reads only.

const LOCKED_OR_LATER = new Set(["locked", "scored", "final"]);
/** Chips that make a week's transfers unlimited (DM 3.8). */
const UNLIMITED = new Set(["wildcard", "limitless"]);

type State = typeof teamEventStates.$inferSelect;
type AssetPick = { assetId: string; isBoost: boolean; assetType: string };

/** A team's standing after an event, as worked out here. */
interface Worked {
  baseVersionId: string | null;
  lockedVersionId: string;
  bank: number;
  carryOverOut: number;
  effect: string | null;
}

/**
 * Checks a game's rules and returns one message per violation, empty when
 * there are none:
 * - every lock record (`team_event_states`) equals the one worked out from
 *   the team's versions, the event's prices and its chip plays: the lineup
 *   that counts (the latest saved for the event before its lock, else one
 *   saved for an event cancelled since the last lock, else the base), the
 *   base and bank carried from the team's previous record (reverted after a
 *   Limitless week), purchasing power, spent, transfers, carry-over, the
 *   penalty and the chip; a team that took part has a record, and only then;
 * - no counted version was saved at or after the event's `lock_at`;
 * - carry-over is never above the ruleset's `carryOverMax`;
 * - each penalty is `transferPenalty` of the record's own counts;
 * - the bank is never below 0 outside a Limitless week;
 * - each chip is played at most once a season, at most one per event, never
 *   left played for a cancelled event, and refunded only for one;
 * - an `after_first_event` chip comes after the team's first event;
 * - the x3 Boost target is a driver in the locked lineup without the 2x Boost;
 * - each Late Call version is the locked lineup with exactly one asset
 *   swapped for one of the same type, the Boost following it, saved while the
 *   event had locked, qualifying's results were in and the race hadn't
 *   started, and with Late Call played.
 */
export async function checkGameInvariants(
  db: Db,
  gameId: string,
): Promise<string[]> {
  const found: string[] = [];

  // --- What the game has --------------------------------------------------
  const calendar = await db
    .select({
      eventId: gameEvents.eventId,
      sequence: gameEvents.sequence,
      status: gameEvents.status,
      rulesetVersionId: gameEvents.rulesetVersionId,
      params: rulesetVersions.params,
      round: events.round,
      lockAt: events.lockAt,
    })
    .from(gameEvents)
    .innerJoin(events, eq(events.id, gameEvents.eventId))
    .innerJoin(
      rulesetVersions,
      eq(rulesetVersions.id, gameEvents.rulesetVersionId),
    )
    .where(eq(gameEvents.gameId, gameId))
    .orderBy(asc(events.lockAt), asc(events.round));
  const eventOf = new Map(
    calendar.map((e) => [
      e.eventId,
      { ...e, rules: rulesetParamsSchema.parse(e.params) },
    ]),
  );
  const bySequence = new Map(
    [...eventOf.values()]
      .filter((e) => e.sequence !== null)
      .map((e) => [e.sequence!, e]),
  );
  const locked = [...bySequence.values()]
    .filter((e) => LOCKED_OR_LATER.has(e.status))
    .sort((a, b) => a.sequence! - b.sequence!);
  const roundOf = (eventId: string) =>
    eventOf.get(eventId)?.round ?? `(event ${eventId})`;

  const teamRows = await db
    .select()
    .from(teams)
    .where(eq(teams.gameId, gameId))
    .orderBy(asc(teams.id));
  const teamIds = teamRows.map((team) => team.id);
  const where = (teamId: string, eventId?: string) =>
    `team "${teamRows.find((team) => team.id === teamId)?.name ?? teamId}"${
      eventId === undefined ? "" : ` round ${roundOf(eventId)}`
    }`;

  // Oldest first, as the database orders saves: by (saved_at, id).
  const versions =
    teamIds.length === 0
      ? []
      : await db
          .select()
          .from(lineupVersions)
          .where(inArray(lineupVersions.teamId, teamIds))
          .orderBy(asc(lineupVersions.savedAt), asc(lineupVersions.id));
  const versionOf = new Map(versions.map((v) => [v.id, v]));
  const picksOf = new Map<string, AssetPick[]>();
  if (versions.length > 0) {
    for (const pick of await db
      .select({
        versionId: lineupPicks.lineupVersionId,
        assetId: lineupPicks.assetId,
        isBoost: lineupPicks.isBoost,
        assetType: poolAssets.assetType,
      })
      .from(lineupPicks)
      .innerJoin(poolAssets, eq(poolAssets.id, lineupPicks.assetId))
      .where(
        inArray(
          lineupPicks.lineupVersionId,
          versions.map((v) => v.id),
        ),
      )) {
      const list = picksOf.get(pick.versionId) ?? [];
      list.push(pick);
      picksOf.set(pick.versionId, list);
    }
  }
  const picks = (versionId: string | null) =>
    versionId === null ? [] : (picksOf.get(versionId) ?? []);

  const prices = new Map(
    (
      await db
        .select({
          assetId: assetPrices.assetId,
          eventId: assetPrices.eventId,
          price: assetPrices.price,
        })
        .from(assetPrices)
        .innerJoin(poolAssets, eq(poolAssets.id, assetPrices.assetId))
        .where(eq(poolAssets.gameId, gameId))
    ).map((p) => [`${p.assetId}|${p.eventId}`, p.price]),
  );
  /** The lineup's cost at the event's prices, or null with a message. */
  const cost = (versionId: string | null, eventId: string, what: string) => {
    let sum = 0;
    for (const { assetId } of picks(versionId)) {
      const price = prices.get(`${assetId}|${eventId}`);
      if (price === undefined) {
        found.push(`${what}: asset ${assetId} has no price for the event`);
        return null;
      }
      sum += price;
    }
    return sum;
  };

  const plays = await db
    .select()
    .from(chipPlays)
    .where(eq(chipPlays.gameId, gameId))
    .orderBy(asc(chipPlays.playedAt), asc(chipPlays.id));
  const played = plays.filter((p) => p.status === "played");
  const chipOf = (code: string, eventId: string) =>
    eventOf.get(eventId)?.rules.chips.find((c) => c.code === code);
  const playedFor = (teamId: string, eventId: string) =>
    played.filter((p) => p.teamId === teamId && p.eventId === eventId);

  const states = await db
    .select()
    .from(teamEventStates)
    .where(eq(teamEventStates.gameId, gameId));
  const stateOf = new Map(states.map((s) => [`${s.teamId}|${s.eventId}`, s]));

  // --- Every lock record, worked out again ---------------------------------
  for (const team of teamRows) {
    const mine = versions.filter((v) => v.teamId === team.id);
    const history: Worked[] = [];
    for (const event of locked) {
      const at = where(team.id, event.eventId);
      const rules = event.rules;
      const row = stateOf.get(`${team.id}|${event.eventId}`);

      // Where the team stands going in: its previous record, or none.
      const last = history.at(-1);
      let base: {
        versionId: string | null;
        bank: number | null;
        carryIn: number;
        isFirst: boolean;
      };
      if (!last) {
        base = { versionId: null, bank: null, carryIn: 0, isFirst: true };
      } else if (last.effect === "limitless") {
        // After Blank Cheque the team goes back to the lineup and bank it had
        // before, and nothing carries in.
        const prior = history.at(-2);
        if (!prior) {
          found.push(`${at}: a Limitless week with no event before it`);
          break;
        }
        base = {
          versionId: last.baseVersionId,
          bank: prior.bank,
          carryIn: 0,
          isFirst: false,
        };
      } else {
        base = {
          versionId: last.lockedVersionId,
          bank: last.bank,
          carryIn: last.carryOverOut,
          isFirst: false,
        };
      }

      // The lineup that counts.
      const before = (v: (typeof versions)[number]) =>
        v.savedAt.getTime() < event.lockAt.getTime();
      const since = bySequence.get(event.sequence! - 1)?.lockAt.getTime();
      const counted =
        mine.findLast(
          (v) =>
            v.forEventId === event.eventId &&
            (v.kind === "regular" || v.kind === "limitless") &&
            before(v),
        ) ??
        mine.findLast(
          (v) =>
            eventOf.get(v.forEventId)?.status === "cancelled" &&
            v.kind === "regular" &&
            before(v) &&
            (since === undefined || v.savedAt.getTime() >= since),
        );
      const lockedVersionId = counted?.id ?? base.versionId;

      if (lockedVersionId === null) {
        if (row) found.push(`${at}: a lock record, but no lineup counts`);
        continue;
      }
      if (!row) {
        if (team.status === "active") {
          found.push(`${at}: a lineup counts, but there is no lock record`);
        }
        continue;
      }

      const chip = playedFor(team.id, event.eventId)[0];
      const effect = chip
        ? (chipOf(chip.chipCode, event.eventId)?.effect ?? null)
        : null;
      const owned = new Set(picks(base.versionId).map((p) => p.assetId));
      const value = base.isFirst ? 0 : cost(base.versionId, event.eventId, at);
      const spent = cost(lockedVersionId, event.eventId, at);
      if (value === null || spent === null) continue;
      const power = base.isFirst ? rules.budget : base.bank! + value;
      const made = new Set(
        picks(lockedVersionId)
          .map((p) => p.assetId)
          .filter((id) => !owned.has(id)),
      ).size;
      const free =
        base.isFirst || (effect !== null && UNLIMITED.has(effect))
          ? null
          : rules.transfers.freePerEvent + base.carryIn;
      const carryOverOut =
        free === null
          ? rules.transfers.carryOverOutInUnlimitedWeek
          : Math.min(rules.transfers.carryOverMax, Math.max(0, free - made));
      const extra = free === null ? 0 : made - free;
      const worked: Partial<Record<keyof State, unknown>> = {
        baseVersionId: base.versionId,
        lockedVersionId,
        finalFixVersionId:
          mine.find(
            (v) => v.kind === "final_fix" && v.forEventId === event.eventId,
          )?.id ?? null,
        chipPlayId: chip?.id ?? null,
        isFirstEvent: base.isFirst,
        purchasingPower: power,
        spent,
        bank: power - spent,
        transfersMade: made,
        freeTransfers: free,
        carryOverOut,
        transferPenalty: extra > 0 ? rules.transfers.penalty * extra : 0,
        rulesetVersionId: event.rulesetVersionId,
      };
      for (const [field, expected] of Object.entries(worked)) {
        const actual = row[field as keyof State];
        if (actual !== expected) {
          found.push(
            `${at}: ${snake(field)} is ${String(actual)}, recomputed ${String(expected)}`,
          );
        }
      }
      history.push({
        baseVersionId: base.versionId,
        lockedVersionId,
        bank: power - spent,
        carryOverOut,
        effect,
      });
    }

    const first = states
      .filter((s) => s.teamId === team.id)
      .map((s) => eventOf.get(s.eventId))
      .filter((e) => e !== undefined)
      .sort((a, b) => (a.sequence ?? Infinity) - (b.sequence ?? Infinity))[0];
    if ((first?.eventId ?? null) !== team.firstEventId) {
      found.push(
        `${where(team.id)}: first_event_id is ${team.firstEventId}, its first lock record is for ${first?.eventId ?? "nothing"}`,
      );
    }
  }

  // --- Rules over each record as written -----------------------------------
  for (const row of states) {
    const at = where(row.teamId, row.eventId);
    const event = eventOf.get(row.eventId);
    if (!event || !LOCKED_OR_LATER.has(event.status)) {
      found.push(`${at}: a lock record for an event that hasn't locked`);
      continue;
    }
    const counted = versionOf.get(row.lockedVersionId);
    if (!counted || counted.savedAt.getTime() >= event.lockAt.getTime()) {
      found.push(
        `${at}: the counted version ${row.lockedVersionId} was saved at ${counted?.savedAt.toISOString()}, not before the lock at ${event.lockAt.toISOString()}`,
      );
    }
    const { transfers } = event.rules;
    if (row.carryOverOut > transfers.carryOverMax || row.carryOverOut < 0) {
      found.push(
        `${at}: carry-over ${row.carryOverOut} is above ${transfers.carryOverMax}`,
      );
    }
    const penalty = transferPenalty(event.rules, {
      free: row.freeTransfers,
      made: row.transfersMade,
    });
    if (row.transferPenalty !== penalty) {
      found.push(
        `${at}: transfer penalty ${row.transferPenalty}, but transferPenalty gives ${penalty}`,
      );
    }
    const chip = played.find((p) => p.id === row.chipPlayId);
    const limitless =
      chip !== undefined &&
      chipOf(chip.chipCode, chip.eventId)?.effect === "limitless";
    if (row.bank < 0 && !limitless) {
      found.push(`${at}: bank ${row.bank} is below 0 outside Limitless`);
    }
  }

  // --- Chips ---------------------------------------------------------------
  for (const team of teamRows) {
    const mine = played.filter((p) => p.teamId === team.id);
    for (const code of new Set(mine.map((p) => p.chipCode))) {
      const n = mine.filter((p) => p.chipCode === code).length;
      if (n > 1) found.push(`${where(team.id)}: ${code} is played ${n} times`);
    }
    for (const eventId of new Set(mine.map((p) => p.eventId))) {
      const n = mine.filter((p) => p.eventId === eventId).length;
      if (n > 1) {
        found.push(
          `${where(team.id, eventId)}: ${n} chips are played for the event`,
        );
      }
    }
  }
  for (const play of plays) {
    const at = where(play.teamId, play.eventId);
    const event = eventOf.get(play.eventId);
    const cancelled = event?.status === "cancelled";
    if (play.status === "refunded") {
      if (!cancelled) {
        found.push(
          `${at}: ${play.chipCode} is refunded, but the event wasn't cancelled`,
        );
      }
      continue;
    }
    if (!event || event.sequence === null) {
      found.push(
        `${at}: ${play.chipCode} is played for an event the game doesn't run`,
      );
      continue;
    }
    const chip = chipOf(play.chipCode, play.eventId);
    if (!chip) {
      found.push(`${at}: ${play.chipCode} isn't a chip of the event's rules`);
      continue;
    }
    if (chip.unlock === "after_first_event") {
      const team = teamRows.find((t) => t.id === play.teamId);
      const first =
        team?.firstEventId === null || team?.firstEventId === undefined
          ? undefined
          : eventOf.get(team.firstEventId);
      if (!first || first.sequence! >= event.sequence) {
        found.push(
          `${at}: ${play.chipCode} unlocks after the team's first event (round ${first ? first.round : "none"})`,
        );
      }
    }
    if (chip.effect === "triple_boost" && LOCKED_OR_LATER.has(event.status)) {
      const row = stateOf.get(`${play.teamId}|${play.eventId}`);
      const target = picks(row?.lockedVersionId ?? null).find(
        (p) => p.assetId === play.targetAssetId,
      );
      if (!target || target.assetType !== "driver" || target.isBoost) {
        found.push(
          `${at}: the x3 Boost target ${play.targetAssetId} is not a driver without the 2x Boost in the locked lineup`,
        );
      }
    }
  }

  // --- Late Call -----------------------------------------------------------
  const lateCalls = versions.filter((v) => v.kind === "final_fix");
  const weekendSessions =
    lateCalls.length === 0
      ? []
      : await db
          .select({
            id: sessions.id,
            eventId: sessions.eventId,
            kind: sessions.kind,
            sequence: sessions.sequence,
            scheduledStart: sessions.scheduledStart,
            results: sessionResultState.status,
          })
          .from(sessions)
          .leftJoin(
            sessionResultState,
            eq(sessionResultState.sessionId, sessions.id),
          )
          .where(
            and(
              inArray(
                sessions.eventId,
                lateCalls.map((v) => v.forEventId),
              ),
              inArray(sessions.kind, ["qualifying", "race"]),
            ),
          )
          .orderBy(asc(sessions.sequence));
  for (const version of lateCalls) {
    const at = where(version.teamId, version.forEventId);
    const what = `the Late Call version ${version.id}`;
    const event = eventOf.get(version.forEventId);
    const row = stateOf.get(`${version.teamId}|${version.forEventId}`);
    if (!event || !row) {
      found.push(
        `${at}: ${what} is for an event the team has no lock record for`,
      );
      continue;
    }
    const chip = playedFor(version.teamId, version.forEventId)[0];
    if (!chip || chipOf(chip.chipCode, chip.eventId)?.effect !== "final_fix") {
      found.push(`${at}: ${what} has no Late Call played for it`);
    }

    const before = picks(row.lockedVersionId);
    const after = picks(version.id);
    const inBefore = new Map(before.map((p) => [p.assetId, p]));
    const inAfter = new Map(after.map((p) => [p.assetId, p]));
    const out = before.filter((p) => !inAfter.has(p.assetId));
    const incoming = after.filter((p) => !inBefore.has(p.assetId));
    if (out.length !== 1 || incoming.length !== 1) {
      found.push(
        `${at}: ${what} swaps ${Math.max(out.length, incoming.length)} assets, not 1`,
      );
    } else if (out[0]!.assetType !== incoming[0]!.assetType) {
      found.push(
        `${at}: ${what} swaps a ${out[0]!.assetType} for a ${incoming[0]!.assetType}`,
      );
    } else if (
      incoming[0]!.isBoost !== out[0]!.isBoost ||
      after.some(
        (p) =>
          inBefore.has(p.assetId) &&
          inBefore.get(p.assetId)!.isBoost !== p.isBoost,
      )
    ) {
      found.push(`${at}: ${what} moves the Boost other than with its asset`);
    }

    const weekend = weekendSessions.filter(
      (s) => s.eventId === version.forEventId,
    );
    const qualifying = weekend.find((s) => s.kind === "qualifying");
    const race = weekend.find((s) => s.kind === "race");
    const saved = version.savedAt.getTime();
    if (
      !qualifying ||
      !race ||
      qualifying.results === null ||
      qualifying.results === "awaiting" ||
      saved < event.lockAt.getTime() ||
      saved < qualifying.scheduledStart.getTime() ||
      saved >= race.scheduledStart.getTime()
    ) {
      found.push(
        `${at}: ${what} was saved at ${version.savedAt.toISOString()}, outside its window`,
      );
    }
    if (version.effectiveFromSessionId !== (race?.id ?? null)) {
      found.push(`${at}: ${what} doesn't apply from the race`);
    }
  }

  return found;
}

/** `transfersMade` as the column is named, `transfers_made`. */
function snake(field: string): string {
  return field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}
