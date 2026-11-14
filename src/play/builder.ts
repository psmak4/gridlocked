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
  teamEventStates,
  teams,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { playedChips } from "@/game/chips";
import { GameError } from "@/game/errors";
import { saveLineup, type LineupPick } from "@/game/lineups";
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
import { refusalOf, type Refusal } from "@/server/play-actions";
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
  sentence: string;
  status: ChipStatus;
  /** The event it was played for, when played or used. */
  playedFor: string | null;
};

/** The locked team's view: M6 Task 9's. */
export type LockedView = never;

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

/** One sentence for each chip, by what it does (the chip sheet). */
const CHIP_SENTENCES: Record<ChipEffect, string> = {
  autopilot: "After the race, your Boost moves to your best-scoring driver.",
  triple_boost: "One driver you choose scores triple points this weekend.",
  no_negative: "Any score below zero counts as zero this weekend.",
  wildcard: "Unlimited transfers this weekend, within your budget.",
  limitless:
    "Unlimited transfers and no budget cap for one weekend. Your team goes back after.",
  final_fix: "One change after qualifying, before the race.",
};

const LOCKED_OR_SCORED = new Set(["locked", "scored"]);

/** A ruleset version's params. */
async function paramsOf(db: Db, versionId: string): Promise<RulesetParams> {
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
  input: { teamId: string; reader: NonNullable<Reader> },
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

  const squad = { ...params.squad };
  const base: BuilderState = {
    team: { id: team.id, slot: team.slot, name: team.name },
    event: null,
    phase,
    pool: [],
    latest: null,
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
  };
}

/** The priced pool at an event, with what each row shows. */
async function poolRows(
  db: Db,
  now: Date,
  input: {
    gameId: string;
    eventId: string;
    seasonId: string;
    round: number;
    previousEventId: string | null;
    reader: NonNullable<Reader>;
    owned: Set<string>;
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
      (await revealedSessions(db, now, input.reader, [race])).has(race);
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
      code: team?.shortName ?? asset.constructorName ?? "",
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
});

/** The builder for the viewer's team in `slot` of the current game. */
export async function builderForSlot(
  db: Db,
  now: Date,
  viewer: Viewer | null,
  data: z.infer<typeof getBuilderInput>,
): Promise<BuilderState> {
  const v = requireComplete(viewer);
  const game = await currentGame(db);
  if (!game) throw new GameError("game_not_open", "no game is open");
  const [team] = await db
    .select({ id: teams.id })
    .from(teams)
    .where(
      and(
        eq(teams.gameId, game.id),
        eq(teams.userId, v.userId),
        eq(teams.slot, data.slot),
      ),
    );
  if (!team) throw new GameError("team_not_owned", "no team in that slot");
  return builderState(db, now, {
    teamId: team.id,
    reader: {
      userId: v.userId,
      spoilerProtection: v.profile.spoilerProtection,
    },
  });
}

export const saveTeamInput = z.object({
  teamId: z.uuid(),
  picks: z.array(z.object({ assetId: z.uuid(), isBoost: z.boolean() })).max(20),
  basedOnVersionId: z.uuid().nullable(),
});

/**
 * Saves a lineup for one of the viewer's teams (`saveLineup`): a new version,
 * with `staleBase` when another save came first. The database's checks
 * decide; a refusal is `{ ok: false, error }`.
 */
export function saveTeamAction(
  db: Db,
  now: Date,
  viewer: Viewer | null,
  data: z.infer<typeof saveTeamInput>,
): Promise<{ ok: true; versionId: string; staleBase: boolean } | Refusal> {
  const v = requireWritable(viewer);
  return refusalOf(async () => {
    const team = await ownTeam(db, v.userId, data.teamId);
    if (team.status === "retired") {
      throw new GameError("team_retired", "a retired team can't be changed");
    }
    const saved = await saveLineup(db, now, data);
    return { ok: true as const, ...saved };
  });
}
