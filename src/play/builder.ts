/**
 * The team builder's read and save (M6 Task 7). `builderState` reads what the
 * builder shows for one team, one query per part (the pool with its prices
 * and availability, the versions, the base, the chips), never one per asset.
 * `saveTeamAction` saves a lineup through the game layer's `saveLineup`,
 * whose database checks decide. The preview is `preview.ts`, pure.
 */
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import {
  assetPrices,
  chipPlays,
  constructorSeasons,
  constructors,
  driverAvailability,
  drivers,
  eventEntries,
  events,
  gameEvents,
  lineupPicks,
  lineupVersions,
  poolAssets,
  rulesetVersions,
  sessions,
  teamEventStates,
  teamEventTotals,
  teams,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { playChip, playedChips, saveFinalFix } from "@/game/chips";
import { GameError } from "@/game/errors";
import { lockedLineup, saveLineup, type LineupPick } from "@/game/lineups";
import {
  rulesetParamsSchema,
  type ChipEffect,
  type RulesetParams,
} from "@/game/ruleset";
import { freeTransfers } from "@/game/transfers";
import {
  requireComplete,
  requireWritable,
  type Viewer,
} from "@/identity/viewer";
import type { MoneyUnits } from "@/lib/money";
import { SCORED_KINDS } from "@/results/validate";
import { refusalOf, type Refusal } from "@/play/refusal";
import { revealedSessions, type Reader } from "@/spoilers/reveal";
import { currentGame } from "./current-game";
import { ownTeam } from "./teams";

export type Availability = "available" | "doubtful" | "out" | "withdrawn";

/** One asset in the builder's pool, at the builder's event. */
export type PoolRow = {
  assetId: string;
  kind: "driver" | "constructor";
  /** "Max Verstappen", or the constructor's name this season. */
  title: string;
  /** A driver's constructor; a constructor's drivers at the event. */
  subtitle: string;
  /** "VER", or the constructor's short name. */
  code: string;
  /** The constructor's `#RRGGBB` accent. */
  color: string;
  price: MoneyUnits;
  /**
   * The change since the event before, or null: at the first event, and
   * while that event's race is hidden from the reader (M6 decision 4).
   */
  delta: MoneyUnits | null;
  availability: Availability;
  /** In the team's base lineup: it owns it, so it keeps a withdrawn one. */
  inBase: boolean;
  /** The share (0 to 1) of the event before's locked teams holding it. */
  ownership: number | null;
};

export type ChipStatus =
  "available" | "played" | "locked_until_first_race" | "used";

export type ChipState = {
  code: string;
  /** Our name: Strategist, Overdrive, Safety Car, Rebuild, Blank Cheque, Late Call. */
  name: string;
  effect: ChipEffect;
  sentence: string;
  status: ChipStatus;
  /** The event it was played for, when played or used. */
  playedFor: string | null;
};

/** One scored session of the locked event, as the locked team shows it. */
export type LockedSession = {
  id: string;
  /** "Qualifying", "Sprint" or "Race". */
  label: string;
  /** It has points: its results are in and scored. Not a spoiler. */
  scored: boolean;
  /** The reader may see it (or asked to with Show it). */
  revealed: boolean;
  /** The team's points there; null while hidden or not scored. */
  points: number | null;
};

/**
 * The locked team (wave 2 "Locked, with qualifying scores hidden"): the
 * lineup that counts, and its points only where the reader may see them. A
 * hidden figure is left out, never sent (M6 decision 2's rule).
 */
export type LockedView = {
  /** The lineup that counts now: the Late Call one once it is played. */
  picks: LineupPick[];
  /** The chip played for the event, by our name. */
  chip: string | null;
  sessions: LockedSession[];
  /** Each pick's points so far, only while `total` is shown. */
  assetPoints: Record<string, number>;
  /** The event's points, only when every scored session is revealed. */
  total: number | null;
  status: "provisional" | "final" | null;
  /** Late Call is played for the event. */
  lateCallPlayed: boolean;
};

export type BuilderPhase = "open" | "locked" | "between";

export type BuilderState = {
  team: { id: string; slot: number; name: string };
  event: {
    id: string;
    name: string;
    round: number;
    lockAt: string;
    raceSessionId: string | null;
  } | null;
  /**
   * `open` while the game has an open event before its lock; `locked` from
   * the lock until the event is final; `between` when nothing is open or
   * locked (the last event is final and the next hasn't opened, or the
   * season is over).
   */
  phase: BuilderPhase;
  pool: PoolRow[];
  /** The team's latest save for the event. */
  latest: { versionId: string; picks: LineupPick[] } | null;
  /**
   * The team's latest version of any event and kind: what a save from this
   * read is based on, so `staleBase` means another save came in between.
   */
  basedOnVersionId: string | null;
  /** The lineup transfers count against; null at the team's first event. */
  base: LineupPick[] | null;
  purchasingPower: MoneyUnits;
  /** This event's free transfers with the carry-over in; null is unlimited. */
  freeTransfers: number | null;
  /** Points for each transfer beyond the free ones; zero or less. */
  penaltyPerTransfer: number;
  squad: { drivers: number; constructors: number; boosts: number };
  chips: ChipState[];
  /** Blank Cheque is played for the event: no budget cap. */
  limitless: boolean;
  /** Overdrive's driver, when it is played for the event. */
  x3TargetAssetId: string | null;
  /** Late Call can be played now: after qualifying, before the race. */
  lateCallOpen: boolean;
  locked: LockedView | null;
};

/** One sentence for each chip, by what it does: the wave 2 chip sheet's. */
const CHIP_SENTENCES: Record<ChipEffect, string> = {
  autopilot: "After the weekend, your Boost moves to your top scorer.",
  triple_boost: "One driver scores 3× this weekend.",
  no_negative: "No scoring category can go below zero this weekend.",
  wildcard: "Unlimited free changes until lock, within budget.",
  limitless:
    "Unlimited changes and no cap for one race. Your team comes back after.",
  final_fix: "One swap after qualifying.",
};

const LOCKED_OR_SCORED = new Set(["locked", "scored"]);

/** A ruleset version's params. */
export async function paramsOf(
  db: Db,
  versionId: string,
): Promise<RulesetParams> {
  const [row] = await db
    .select({ params: rulesetVersions.params })
    .from(rulesetVersions)
    .where(eq(rulesetVersions.id, versionId));
  if (!row) throw new Error(`builder: no ruleset version ${versionId}`);
  return rulesetParamsSchema.parse(row.params);
}

/** The game's latest ruleset version that isn't a correction. */
async function latestParams(db: Db, gameId: string): Promise<RulesetParams> {
  const [row] = await db
    .select({ id: rulesetVersions.id })
    .from(rulesetVersions)
    .where(
      and(
        eq(rulesetVersions.gameId, gameId),
        eq(rulesetVersions.isCorrection, false),
      ),
    )
    .orderBy(desc(rulesetVersions.version))
    .limit(1);
  if (!row) throw new Error(`builder: game ${gameId} has no ruleset version`);
  return paramsOf(db, row.id);
}

/**
 * Each pool asset's real-world status at an event, by asset id. Withdrawn is
 * placed by sequence, as the lineup check places it. A driver is out when an
 * admin or the roster check says unavailable or reserve, or when the event's
 * entry list (made from the seats) doesn't have him; doubtful when they say
 * so. It is for people, never for scoring (DM 1.10).
 */
export async function poolAvailability(
  db: Db,
  input: { gameId: string; eventId: string },
): Promise<Map<string, Availability>> {
  const { gameId, eventId } = input;
  const [placed] = await db
    .select({ sequence: gameEvents.sequence })
    .from(gameEvents)
    .where(and(eq(gameEvents.gameId, gameId), eq(gameEvents.eventId, eventId)));
  const sequence = placed?.sequence ?? null;

  const assets = await db
    .select({
      id: poolAssets.id,
      driverId: poolAssets.driverId,
      withdrawn:
        sequence === null
          ? sql<boolean>`${poolAssets.status} = 'withdrawn'`
          : sql<boolean>`coalesce((${poolAssets.status} = 'withdrawn' and ${poolAssets.withdrawnFromEventId} is null)
              or game_event_sequence_from(${poolAssets.gameId}, ${poolAssets.withdrawnFromEventId}) <= ${sequence}, false)`,
    })
    .from(poolAssets)
    .where(eq(poolAssets.gameId, gameId));
  const entered = new Set(
    (
      await db
        .select({ driverId: eventEntries.driverId })
        .from(eventEntries)
        .where(eq(eventEntries.eventId, eventId))
    ).map((row) => row.driverId),
  );
  const status = new Map(
    (
      await db
        .select({
          driverId: driverAvailability.driverId,
          status: driverAvailability.status,
        })
        .from(driverAvailability)
        .where(eq(driverAvailability.eventId, eventId))
    ).map((row) => [row.driverId, row.status]),
  );

  const found = new Map<string, Availability>();
  for (const asset of assets) {
    if (asset.withdrawn) {
      found.set(asset.id, "withdrawn");
      continue;
    }
    if (asset.driverId === null) {
      found.set(asset.id, "available");
      continue;
    }
    const said = status.get(asset.driverId);
    if (said === "unavailable" || said === "reserve") {
      found.set(asset.id, "out");
    } else if (entered.size > 0 && !entered.has(asset.driverId)) {
      found.set(asset.id, "out");
    } else {
      found.set(asset.id, said === "doubtful" ? "doubtful" : "available");
    }
  }
  return found;
}

/** The picks of each version, by version id. */
async function picksOf(
  db: Db,
  versionIds: string[],
): Promise<Map<string, LineupPick[]>> {
  const found = new Map<string, LineupPick[]>(versionIds.map((id) => [id, []]));
  if (versionIds.length === 0) return found;
  const rows = await db
    .select({
      versionId: lineupPicks.lineupVersionId,
      assetId: lineupPicks.assetId,
      isBoost: lineupPicks.isBoost,
    })
    .from(lineupPicks)
    .where(inArray(lineupPicks.lineupVersionId, versionIds));
  for (const row of rows) {
    found.get(row.versionId)!.push({
      assetId: row.assetId,
      isBoost: row.isBoost,
    });
  }
  return found;
}

/**
 * Everything the builder shows for one team (M6 Task 7). Refuses another
 * user's team (`team_not_owned`).
 */
export async function builderState(
  db: Db,
  now: Date,
  input: {
    teamId: string;
    reader: NonNullable<Reader>;
    /** Sessions to show this once ("Show it"), not stored. */
    show?: string[];
  },
): Promise<BuilderState> {
  const { teamId, reader } = input;
  const [team] = await db.select().from(teams).where(eq(teams.id, teamId));
  if (!team || team.userId !== reader.userId) {
    throw new GameError("team_not_owned", "not your team");
  }

  // --- Where the game is -----------------------------------------------------
  const calendar = await db
    .select({
      eventId: gameEvents.eventId,
      sequence: gameEvents.sequence,
      status: gameEvents.status,
      rulesetVersionId: gameEvents.rulesetVersionId,
      name: events.name,
      round: events.round,
      seasonId: events.seasonId,
      lockAt: events.lockAt,
    })
    .from(gameEvents)
    .innerJoin(events, eq(events.id, gameEvents.eventId))
    .where(eq(gameEvents.gameId, team.gameId))
    .orderBy(asc(gameEvents.sequence));
  const sequenced = calendar.filter((e) => e.sequence !== null);
  const open = sequenced.find((e) => e.status === "open");
  const lastLocked = [...sequenced]
    .reverse()
    .find((e) => LOCKED_OR_SCORED.has(e.status) || e.status === "final");
  let phase: BuilderPhase;
  let current: (typeof calendar)[number] | undefined;
  if (open) {
    phase = now.getTime() < open.lockAt.getTime() ? "open" : "locked";
    current = open;
  } else if (lastLocked && LOCKED_OR_SCORED.has(lastLocked.status)) {
    phase = "locked";
    current = lastLocked;
  } else {
    phase = "between";
  }

  const chipRows = await db
    .select({
      code: chipPlays.chipCode,
      eventId: chipPlays.eventId,
      eventName: events.name,
    })
    .from(chipPlays)
    .innerJoin(events, eq(events.id, chipPlays.eventId))
    .where(and(eq(chipPlays.teamId, teamId), eq(chipPlays.status, "played")));

  const params = current
    ? await paramsOf(db, current.rulesetVersionId)
    : await latestParams(db, team.gameId);
  const firstSequence =
    calendar.find((e) => e.eventId === team.firstEventId)?.sequence ?? null;
  const chips: ChipState[] = params.chips.map((chip) => {
    const play = chipRows.find((row) => row.code === chip.code);
    const waits =
      chip.unlock === "after_first_event" &&
      (firstSequence === null ||
        !current ||
        current.sequence === null ||
        current.sequence <= firstSequence);
    return {
      code: chip.code,
      name: chip.name,
      effect: chip.effect,
      sentence: CHIP_SENTENCES[chip.effect],
      status: play
        ? play.eventId === current?.eventId
          ? "played"
          : "used"
        : waits
          ? "locked_until_first_race"
          : "available",
      playedFor: play?.eventName ?? null,
    };
  });

  // What `saveLineup` calls the team's latest: any event, any kind.
  const [lastSaved] = await db
    .select({ id: lineupVersions.id })
    .from(lineupVersions)
    .where(eq(lineupVersions.teamId, teamId))
    .orderBy(desc(lineupVersions.savedAt), desc(lineupVersions.id))
    .limit(1);

  const squad = { ...params.squad };
  const base: BuilderState = {
    team: { id: team.id, slot: team.slot, name: team.name },
    event: null,
    phase,
    pool: [],
    latest: null,
    basedOnVersionId: lastSaved?.id ?? null,
    base: null,
    purchasingPower: 0,
    freeTransfers: null,
    penaltyPerTransfer: params.transfers.penalty,
    squad,
    chips,
    limitless: false,
    x3TargetAssetId: null,
    lateCallOpen: false,
    locked: null,
  };
  if (!current) return base;
  const eventId = current.eventId;

  // --- The event: race, base, money, chip ------------------------------------
  const { rows: raceRows } = (await db.execute(
    sql`select event_race_session(${eventId}::uuid) as id`,
  )) as { rows: Array<{ id: string | null }> };
  const raceSessionId = raceRows[0]?.id ?? null;

  const { rows: baseRows } = (await db.execute(sql`
    select b.base_version_id, b.bank, b.carry_in, b.is_first,
           team_purchasing_power(${teamId}::uuid, ${eventId}::uuid) as power,
           final_fix_window_open(${eventId}::uuid) as late_call
    from team_base_state(${teamId}::uuid, ${eventId}::uuid) b
  `)) as {
    rows: Array<{
      base_version_id: string | null;
      carry_in: number;
      is_first: boolean;
      power: number;
      late_call: boolean;
    }>;
  };
  const state = baseRows[0]!;

  const [latestVersion] = await db
    .select({ id: lineupVersions.id })
    .from(lineupVersions)
    .where(
      and(
        eq(lineupVersions.teamId, teamId),
        eq(lineupVersions.forEventId, eventId),
        ne(lineupVersions.kind, "final_fix"),
      ),
    )
    .orderBy(desc(lineupVersions.savedAt), desc(lineupVersions.id))
    .limit(1);
  const versionPicks = await picksOf(
    db,
    [state.base_version_id, latestVersion?.id].filter(
      (id): id is string => typeof id === "string",
    ),
  );
  const basePicks = state.base_version_id
    ? versionPicks.get(state.base_version_id)!
    : null;

  const chip = (await playedChips(db, { eventId, teamIds: [teamId] })).get(
    teamId,
  );

  // --- The pool --------------------------------------------------------------
  const previous = [...sequenced]
    .reverse()
    .find(
      (e) =>
        current.sequence !== null &&
        e.sequence! < current.sequence &&
        e.status !== "cancelled",
    );
  const pool = await poolRows(db, now, {
    gameId: team.gameId,
    eventId,
    seasonId: current.seasonId,
    round: current.round,
    previousEventId: previous?.eventId ?? null,
    reader,
    owned: new Set((basePicks ?? []).map((p) => p.assetId)),
  });

  return {
    ...base,
    event: {
      id: eventId,
      name: current.name,
      round: current.round,
      lockAt: current.lockAt.toISOString(),
      raceSessionId,
    },
    pool,
    latest: latestVersion
      ? {
          versionId: latestVersion.id,
          picks: versionPicks.get(latestVersion.id)!,
        }
      : null,
    base: basePicks,
    purchasingPower: Number(state.power),
    freeTransfers: freeTransfers(params, {
      isFirstEvent: state.is_first,
      carryIn: Number(state.carry_in),
      unlimited: chip?.effect === "wildcard" || chip?.effect === "limitless",
    }),
    limitless: chip?.effect === "limitless",
    x3TargetAssetId:
      chip?.effect === "triple_boost" ? chip.targetAssetId : null,
    lateCallOpen: phase === "locked" && state.late_call === true,
    locked:
      phase === "locked"
        ? await lockedView(db, now, {
            teamId,
            eventId,
            reader,
            show: input.show,
          })
        : null,
  };
}

const SESSION_LABELS: Record<string, string> = {
  qualifying: "Qualifying",
  sprint: "Sprint",
  race: "Race",
};

/**
 * The locked team for one event (M6 Task 9): the lineup that counts, the
 * chip, and the points of each scored session the reader may see, from
 * `team_event_totals`. A hidden session has no points here, and the total
 * and each pick's points are left out while any scored session is hidden.
 * `show` reveals sessions this once ("Show it"); it is never stored.
 */
export async function lockedView(
  db: Db,
  now: Date,
  input: {
    teamId: string;
    eventId: string;
    reader: NonNullable<Reader>;
    show?: string[];
  },
): Promise<LockedView> {
  const { teamId, eventId, reader } = input;

  // The lineup: the lock record's (the Late Call one once played), else the
  // one the lock will take, for the minutes before the lock job runs.
  const [record] = await db
    .select({
      lockedVersionId: teamEventStates.lockedVersionId,
      finalFixVersionId: teamEventStates.finalFixVersionId,
    })
    .from(teamEventStates)
    .where(
      and(
        eq(teamEventStates.teamId, teamId),
        eq(teamEventStates.eventId, eventId),
      ),
    );
  let picks: LineupPick[] = [];
  if (record) {
    const id = record.finalFixVersionId ?? record.lockedVersionId;
    picks = (await picksOf(db, [id])).get(id) ?? [];
  } else {
    picks = (await lockedLineup(db, { teamId, eventId }))?.picks ?? [];
  }

  const chip = (await playedChips(db, { eventId, teamIds: [teamId] })).get(
    teamId,
  );
  const chipName = chip
    ? await chipNameOf(db, { teamId, eventId, code: chip.code })
    : null;

  const eventSessions = await db
    .select({ id: sessions.id, kind: sessions.kind })
    .from(sessions)
    .where(
      and(
        eq(sessions.eventId, eventId),
        inArray(sessions.kind, [...SCORED_KINDS]),
      ),
    )
    .orderBy(asc(sessions.scheduledStart), asc(sessions.sequence));
  const ids = eventSessions.map((s) => s.id);
  const revealed = await revealedSessions(db, now, reader, ids);
  for (const id of input.show ?? []) {
    if (ids.includes(id)) revealed.add(id);
  }

  const [totals] = await db
    .select({
      points: teamEventTotals.points,
      bySession: teamEventTotals.pointsBySession,
      status: teamEventTotals.status,
    })
    .from(teamEventTotals)
    .where(
      and(
        eq(teamEventTotals.teamId, teamId),
        eq(teamEventTotals.eventId, eventId),
      ),
    );
  const bySession = totals?.bySession ?? {};
  const list: LockedSession[] = eventSessions.map((s) => {
    const scored = typeof bySession[s.id] === "number";
    const shown = revealed.has(s.id);
    return {
      id: s.id,
      label: SESSION_LABELS[s.kind] ?? s.kind,
      scored,
      revealed: shown,
      points: scored && shown ? bySession[s.id]! : null,
    };
  });
  const allShown =
    totals !== undefined &&
    list.some((s) => s.scored) &&
    list.every((s) => !s.scored || s.revealed);

  let assetPoints: Record<string, number> = {};
  if (allShown) {
    // Each asset's base points in the sessions it counted for, and the
    // team's adjustments on it (Boost, Overdrive, Safety Car).
    const { rows } = (await db.execute(sql`
      select asset_id, sum(points)::int as points from (
        select asset_id, points from team_base_lines
        where team_id = ${teamId}::uuid and event_id = ${eventId}::uuid
        union all
        select asset_id, points from team_adjustment_lines
        where team_id = ${teamId}::uuid and event_id = ${eventId}::uuid
          and asset_id is not null and session_id is not null
      ) lines group by asset_id
    `)) as { rows: Array<{ asset_id: string; points: number }> };
    assetPoints = Object.fromEntries(
      rows.map((row) => [row.asset_id, Number(row.points)]),
    );
  }

  return {
    picks,
    chip: chipName,
    sessions: list,
    assetPoints,
    total: allShown ? totals.points : null,
    status: allShown ? totals.status : null,
    lateCallPlayed: chip?.effect === "final_fix",
  };
}

/** A chip's name in the ruleset of the team's game at the event. */
async function chipNameOf(
  db: Db,
  input: { teamId: string; eventId: string; code: string },
): Promise<string> {
  const [row] = await db
    .select({ versionId: gameEvents.rulesetVersionId })
    .from(gameEvents)
    .innerJoin(teams, eq(teams.gameId, gameEvents.gameId))
    .where(
      and(eq(teams.id, input.teamId), eq(gameEvents.eventId, input.eventId)),
    );
  if (!row) return input.code;
  const params = await paramsOf(db, row.versionId);
  return params.chips.find((c) => c.code === input.code)?.name ?? input.code;
}

/**
 * A constructor's badge code (TeamBadge holds three letters): the first three
 * letters of its short name without "F1 Team", so "McLaren" is MCL, "Haas F1
 * Team" HAA, "Aston Martin" AST and "RB F1 Team" RB.
 */
export function constructorCode(shortName: string): string {
  const letters = shortName
    .replace(/\bF1 Team\b/i, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
  return letters.slice(0, 3).toUpperCase();
}

/**
 * The priced pool at an event, with what each row shows. The change since
 * `previousEventId` shows once that event's race is revealed to `reader`, or
 * with `showChanges` (Prices' "Show it", M6 Task 14).
 */
export async function poolRows(
  db: Db,
  now: Date,
  input: {
    gameId: string;
    eventId: string;
    seasonId: string;
    round: number;
    previousEventId: string | null;
    reader: Reader;
    owned: Set<string>;
    showChanges?: boolean;
  },
): Promise<PoolRow[]> {
  const { gameId, eventId, seasonId, previousEventId } = input;
  const assets = await db
    .select({
      id: poolAssets.id,
      kind: poolAssets.assetType,
      driverId: poolAssets.driverId,
      constructorId: poolAssets.constructorId,
      price: assetPrices.price,
      givenName: drivers.givenName,
      familyName: drivers.familyName,
      displayName: drivers.displayName,
      code: drivers.code,
      constructorName: constructors.name,
    })
    .from(poolAssets)
    .innerJoin(
      assetPrices,
      and(
        eq(assetPrices.assetId, poolAssets.id),
        eq(assetPrices.eventId, eventId),
      ),
    )
    .leftJoin(drivers, eq(drivers.id, poolAssets.driverId))
    .leftJoin(constructors, eq(constructors.id, poolAssets.constructorId))
    .where(eq(poolAssets.gameId, gameId));

  // How each constructor appears this season.
  const look = new Map(
    (
      await db
        .select({
          constructorId: constructorSeasons.constructorId,
          name: constructorSeasons.displayName,
          shortName: constructorSeasons.shortName,
          color: constructorSeasons.color,
        })
        .from(constructorSeasons)
        .where(eq(constructorSeasons.seasonId, seasonId))
    ).map((row) => [row.constructorId, row]),
  );

  // Each driver's car: the entry at this event, else his latest this season.
  const { rows: carRows } = (await db.execute(sql`
    select distinct on (ee.driver_id) ee.driver_id, ee.constructor_id,
           (ee.event_id = ${eventId}::uuid) as here
    from ${eventEntries} ee
    join ${events} e on e.id = ee.event_id
    where e.season_id = ${seasonId}::uuid and e.round <= ${input.round}
    order by ee.driver_id, e.round desc
  `)) as {
    rows: Array<{ driver_id: string; constructor_id: string; here: boolean }>;
  };
  const carOf = new Map(carRows.map((row) => [row.driver_id, row]));
  const lineUp = new Map<string, string[]>();
  for (const asset of assets) {
    const car = asset.driverId ? carOf.get(asset.driverId) : undefined;
    if (!car?.here) continue;
    lineUp.set(car.constructor_id, [
      ...(lineUp.get(car.constructor_id) ?? []),
      asset.familyName ?? "",
    ]);
  }

  const availability = await poolAvailability(db, { gameId, eventId });

  // The event before: its prices (shown only once its race is revealed) and
  // how many of its locked teams held each asset.
  let previousPrice = new Map<string, number>();
  let held = new Map<string, number>();
  let lockedTeams = 0;
  if (previousEventId) {
    const race = (
      (await db.execute(
        sql`select event_race_session(${previousEventId}::uuid) as id`,
      )) as { rows: Array<{ id: string | null }> }
    ).rows[0]?.id;
    const revealed =
      race != null &&
      (input.showChanges === true ||
        (await revealedSessions(db, now, input.reader, [race])).has(race));
    if (revealed) {
      previousPrice = new Map(
        (
          await db
            .select({ assetId: assetPrices.assetId, price: assetPrices.price })
            .from(assetPrices)
            .where(eq(assetPrices.eventId, previousEventId))
        ).map((row) => [row.assetId, row.price]),
      );
    }
    const [{ n } = { n: 0 }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(teamEventStates)
      .where(
        and(
          eq(teamEventStates.gameId, gameId),
          eq(teamEventStates.eventId, previousEventId),
        ),
      );
    lockedTeams = n;
    held = new Map(
      (
        await db
          .select({
            assetId: lineupPicks.assetId,
            n: sql<number>`count(*)::int`,
          })
          .from(teamEventStates)
          .innerJoin(
            lineupPicks,
            eq(lineupPicks.lineupVersionId, teamEventStates.lockedVersionId),
          )
          .where(
            and(
              eq(teamEventStates.gameId, gameId),
              eq(teamEventStates.eventId, previousEventId),
            ),
          )
          .groupBy(lineupPicks.assetId)
      ).map((row) => [row.assetId, row.n]),
    );
  }

  const rows: PoolRow[] = assets.map((asset) => {
    const before = previousPrice.get(asset.id);
    const shared = {
      assetId: asset.id,
      price: asset.price,
      delta: before === undefined ? null : asset.price - before,
      availability: availability.get(asset.id) ?? "available",
      inBase: input.owned.has(asset.id),
      ownership:
        lockedTeams > 0 ? (held.get(asset.id) ?? 0) / lockedTeams : null,
    };
    if (asset.kind === "driver") {
      const car = asset.driverId ? carOf.get(asset.driverId) : undefined;
      const team = car ? look.get(car.constructor_id) : undefined;
      return {
        ...shared,
        kind: "driver",
        title:
          asset.displayName ?? `${asset.givenName} ${asset.familyName}`.trim(),
        subtitle: team?.name ?? "",
        code: asset.code ?? (asset.familyName ?? "").slice(0, 3).toUpperCase(),
        color: team?.color ?? "#808080",
      };
    }
    const team = asset.constructorId
      ? look.get(asset.constructorId)
      : undefined;
    return {
      ...shared,
      kind: "constructor",
      title: team?.name ?? asset.constructorName ?? "",
      subtitle: (asset.constructorId
        ? (lineUp.get(asset.constructorId) ?? [])
        : []
      ).join(" · "),
      code: constructorCode(team?.shortName ?? asset.constructorName ?? ""),
      color: team?.color ?? "#808080",
    };
  });
  // Drivers first, then constructors, each dearest first.
  return rows.sort(
    (a, b) =>
      (a.kind === b.kind ? 0 : a.kind === "driver" ? -1 : 1) ||
      b.price - a.price ||
      a.title.localeCompare(b.title),
  );
}

// --- Server-function bodies --------------------------------------------------

export const getBuilderInput = z.object({
  slot: z.number().int().min(1).max(10),
  /** Sessions to show this once ("Show it", the page's `?show=`). */
  show: z.array(z.uuid()).max(10).optional(),
});

/** The builder page: the state, and what the screen needs to show time. */
export type BuilderPage = {
  state: BuilderState;
  /** The request's "now", so the countdown runs on the server's clock. */
  now: string;
  /** The viewer's IANA time zone (`profiles.timezone`), for the lock time. */
  timeZone: string;
};

/** The builder for the viewer's active team in `slot` of the current game. */
export async function builderForSlot(
  db: Db,
  now: Date,
  viewer: Viewer | null,
  data: z.infer<typeof getBuilderInput>,
): Promise<BuilderPage> {
  const v = requireComplete(viewer);
  const game = await currentGame(db);
  if (!game) throw new GameError("game_not_open", "no game is open");
  const [team] = await db
    .select({ id: teams.id, status: teams.status })
    .from(teams)
    .where(
      and(
        eq(teams.gameId, game.id),
        eq(teams.userId, v.userId),
        eq(teams.slot, data.slot),
      ),
    );
  if (!team) throw new GameError("team_not_owned", "no team in that slot");
  if (team.status === "retired") {
    throw new GameError("team_retired", "that team is retired");
  }
  const state = await builderState(db, now, {
    teamId: team.id,
    reader: {
      userId: v.userId,
      spoilerProtection: v.profile.spoilerProtection,
    },
    show: data.show,
  });
  return { state, now: now.toISOString(), timeZone: v.profile.timezone };
}

export const saveTeamInput = z.object({
  teamId: z.uuid(),
  /** The event the page was built for: a save never lands in another. */
  eventId: z.uuid(),
  picks: z.array(z.object({ assetId: z.uuid(), isBoost: z.boolean() })).max(20),
  basedOnVersionId: z.uuid().nullable(),
});

export type SaveTeamResult =
  | {
      ok: true;
      versionId: string;
      staleBase: boolean;
      /** With `staleBase`: the picks of the save this one came after. */
      theirs: LineupPick[] | null;
    }
  | Refusal;

/**
 * Saves a lineup for one of the viewer's teams (`saveLineup`): a new version,
 * with `staleBase` and the other save's picks when another save came first.
 * A page built for an event that is no longer the open one (it locked, and
 * maybe the next opened) is `window_closed`, so a save never lands in an
 * event the player hasn't seen. The database's checks decide the rest; a
 * refusal is `{ ok: false, error }`.
 */
export function saveTeamAction(
  db: Db,
  now: Date,
  viewer: Viewer | null,
  data: z.infer<typeof saveTeamInput>,
): Promise<SaveTeamResult> {
  const v = requireWritable(viewer);
  return refusalOf(async () => {
    const team = await ownTeam(db, v.userId, data.teamId);
    if (team.status === "retired") {
      throw new GameError("team_retired", "a retired team can't be changed");
    }
    const [open] = await db
      .select({ eventId: gameEvents.eventId })
      .from(gameEvents)
      .where(
        and(eq(gameEvents.gameId, team.gameId), eq(gameEvents.status, "open")),
      );
    if (open?.eventId !== data.eventId) {
      throw new GameError("window_closed", "that event isn't open");
    }
    const saved = await saveLineup(db, now, {
      teamId: data.teamId,
      picks: data.picks,
      basedOnVersionId: data.basedOnVersionId,
    });
    let theirs: LineupPick[] | null = null;
    if (saved.staleBase) {
      // The version saved just before this one: the other device's.
      const [before] = await db
        .select({ id: lineupVersions.id })
        .from(lineupVersions)
        .where(
          and(
            eq(lineupVersions.teamId, data.teamId),
            ne(lineupVersions.id, saved.versionId),
          ),
        )
        .orderBy(desc(lineupVersions.savedAt), desc(lineupVersions.id))
        .limit(1);
      if (before) {
        theirs = (await picksOf(db, [before.id])).get(before.id) ?? [];
      }
    }
    return { ok: true as const, ...saved, theirs };
  });
}

/** An active team of the viewer's, for a chip: refuses a retired one. */
async function activeTeam(db: Db, userId: string, teamId: string) {
  const team = await ownTeam(db, userId, teamId);
  if (team.status === "retired") {
    throw new GameError("team_retired", "a retired team can't be changed");
  }
  return team;
}

export const playChipInput = z.object({
  teamId: z.uuid(),
  /** The event the page was built for: a chip never lands in another. */
  eventId: z.uuid(),
  chipCode: z.string().min(1).max(64),
  /** Overdrive's driver; no other chip takes one. */
  targetAssetId: z.uuid().optional(),
});

/**
 * Plays a chip for one of the viewer's teams (`playChip`). The page's event
 * must be the open one (else `chip_window_closed`); Late Call is played with
 * its swap (`lateCallAction`), so here it is `chip_unavailable`, as is a
 * code the event's ruleset doesn't have. A target on a chip that takes none
 * is `composition`. The database decides the rest.
 */
export function playChipAction(
  db: Db,
  now: Date,
  viewer: Viewer | null,
  data: z.infer<typeof playChipInput>,
): Promise<{ ok: true } | Refusal> {
  const v = requireWritable(viewer);
  return refusalOf(async () => {
    const team = await activeTeam(db, v.userId, data.teamId);
    const [open] = await db
      .select({
        eventId: gameEvents.eventId,
        rulesetVersionId: gameEvents.rulesetVersionId,
      })
      .from(gameEvents)
      .where(
        and(eq(gameEvents.gameId, team.gameId), eq(gameEvents.status, "open")),
      );
    if (open?.eventId !== data.eventId) {
      throw new GameError("chip_window_closed", "that event isn't open");
    }
    const chip = (await paramsOf(db, open.rulesetVersionId)).chips.find(
      (c) => c.code === data.chipCode,
    );
    if (!chip || chip.effect === "final_fix") {
      throw new GameError("chip_unavailable", "that chip can't be played here");
    }
    if (chip.effect !== "triple_boost" && data.targetAssetId !== undefined) {
      throw new GameError("composition", `${chip.name} takes no driver`);
    }
    await playChip(db, now, {
      teamId: data.teamId,
      chipCode: data.chipCode,
      targetAssetId: data.targetAssetId,
    });
    return { ok: true as const };
  });
}

export const lateCallInput = z.object({
  teamId: z.uuid(),
  /** The locked event the page was built for. */
  eventId: z.uuid(),
  outAssetId: z.uuid(),
  inAssetId: z.uuid(),
});

/**
 * Late Call for one of the viewer's teams (`saveFinalFix`): one swap in the
 * locked lineup, from the race on. The page's event must be the game's
 * latest locked one (else `chip_window_closed`); the database decides the
 * window, the budget and the swap.
 */
export function lateCallAction(
  db: Db,
  now: Date,
  viewer: Viewer | null,
  data: z.infer<typeof lateCallInput>,
): Promise<{ ok: true } | Refusal> {
  const v = requireWritable(viewer);
  return refusalOf(async () => {
    const team = await activeTeam(db, v.userId, data.teamId);
    const [latest] = await db
      .select({ eventId: gameEvents.eventId })
      .from(gameEvents)
      .where(
        and(
          eq(gameEvents.gameId, team.gameId),
          inArray(gameEvents.status, ["locked", "scored"]),
        ),
      )
      .orderBy(desc(gameEvents.sequence))
      .limit(1);
    if (latest?.eventId !== data.eventId) {
      throw new GameError("chip_window_closed", "that event isn't locked");
    }
    await saveFinalFix(db, now, {
      teamId: data.teamId,
      outAssetId: data.outAssetId,
      inAssetId: data.inAssetId,
    });
    return { ok: true as const };
  });
}
