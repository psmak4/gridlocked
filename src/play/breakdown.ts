/**
 * The points breakdown (M6 Task 11, wave 3's "One weekend, by session, with
 * a correction note" and "Driver points line by line"). It reads the ledger
 * (DM Part 4): each asset's lines in a session (`asset_score_lines`), the
 * team's own lines (`team_adjustment_lines`) and the event's stored total
 * (`team_event_totals`). It asks the spoiler check first and leaves out
 * every figure of a session the reader hasn't seen: no rows, no points, no
 * total, no Boost line (M6 decision 2's rule).
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import {
  ADJUSTMENT_LINE_TYPES,
  SCORING_RUN_TRIGGERS,
  assetScoreLines,
  constructorSeasons,
  constructors,
  drivers,
  eventEntries,
  events,
  poolAssets,
  scoringRuns,
  sessions,
  teamAdjustmentLines,
  teamEventStates,
  teamEventTotals,
  teams,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { GameError } from "@/game/errors";
import { requireComplete, type Viewer } from "@/identity/viewer";
import { SCORED_KINDS } from "@/results/validate";
import { revealedSessions, type Reader } from "@/spoilers/reveal";
import { constructorCode } from "./builder";
import { currentGame } from "./current-game";
import { rowReason, sheetWords } from "./line-words";
import { readerOf } from "./weekend";

type AdjustmentKind = (typeof ADJUSTMENT_LINE_TYPES)[number];
type RunTrigger = (typeof SCORING_RUN_TRIGGERS)[number];

/** One line of the driver sheet. */
export type SheetLine = { label: string; why: string; points: number };

/** One asset of the lineup in one session. */
export type BreakdownRow = {
  assetId: string;
  kind: "driver" | "constructor";
  /** "Antonelli", or the constructor's name this season. */
  title: string;
  code: string;
  color: string;
  /** Its points there, before the team's own lines (Boost and the rest). */
  points: number;
  /** "P3 · gained 3 places". */
  reason: string;
  /** "2×" for the Boost, "3×" for Overdrive. */
  badges: string[];
  /** The driver sheet: the lines that add up to `points`. */
  lines: SheetLine[];
};

/** A line of the team's own: Boost, a chip, the transfer penalty. */
export type BreakdownExtra = {
  kind: AdjustmentKind;
  /** Null for an event-level line: the transfer penalty, Strategist's move. */
  sessionId: string | null;
  assetId: string | null;
  /** "2× Boost · Antonelli". */
  label: string;
  /** "Doubles the race points". */
  why: string;
  points: number;
};

export type BreakdownSession = {
  id: string;
  /** "Qualifying", "Sprint" or "Race". */
  label: string;
  /** Its results are in and scored. Not a spoiler. */
  scored: boolean;
  /** The reader may see it (or asked to with Show it). */
  revealed: boolean;
  /** The team's points there; null while hidden or not scored. */
  points: number | null;
  /** Empty while hidden or not scored. */
  rows: BreakdownRow[];
};

export type Breakdown = {
  team: { id: string; slot: number; name: string };
  event: { id: string; name: string; round: number };
  /** The rounds this team has points for, oldest first: the round links. */
  rounds: number[];
  status: "provisional" | "final";
  /** The event's points, only when every scored session is revealed. */
  total: number | null;
  /** One sentence per corrected session the reader may see. */
  correction: string | null;
  sessions: BreakdownSession[];
  /**
   * The team's own lines of revealed sessions; the event-level ones only
   * when every scored session is revealed.
   */
  extras: BreakdownExtra[];
};

const SESSION_LABELS: Record<string, string> = {
  qualifying: "Qualifying",
  sprint: "Sprint",
  race: "Race",
};

/** What a re-score says, by what started it (M6 "My calls"). */
const CORRECTION_WORDS: Record<RunTrigger, (label: string) => string> = {
  results: (label) =>
    `${label} results were updated after a stewards' decision.`,
  // An override's reason is written for staff, so it stays out.
  override: (label) => `${label} results were corrected after the session.`,
  exception: (label) => `${label} was voided.`,
  ruleset_correction: (label) => `${label} was rescored after a rules fix.`,
  engine_change: (label) => `${label} was rescored after a rules fix.`,
  admin: (label) => `${label} was rescored.`,
  replay: (label) => `${label} was rescored.`,
};

/**
 * The correction note: a sentence for each session whose current run isn't
 * its first, by what started that run. Null when nothing was corrected.
 */
export function correctionNote(
  list: Array<{ label: string; runs: number; trigger: RunTrigger | null }>,
): string | null {
  const sentences = list
    .filter((s) => s.runs > 1 && s.trigger !== null)
    .map((s) => CORRECTION_WORDS[s.trigger!](s.label));
  return sentences.length > 0 ? sentences.join(" ") : null;
}

/** "race_penalty" → "Race penalty". */
const categoryWords = (category: string | null) => {
  const text = (category ?? "points").replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
};

/** How each asset appears at an event: name, badge code and color. */
type Look = {
  kind: "driver" | "constructor";
  title: string;
  code: string;
  color: string;
};

const GREY = "#808080";

async function looksOf(
  db: Db,
  input: { gameId: string; eventId: string; assetIds: string[] },
): Promise<Map<string, Look>> {
  const ids = [...new Set(input.assetIds)];
  if (ids.length === 0) return new Map();
  const [event] = await db
    .select({ seasonId: events.seasonId })
    .from(events)
    .where(eq(events.id, input.eventId));
  const assets = await db
    .select({
      id: poolAssets.id,
      kind: poolAssets.assetType,
      driverId: poolAssets.driverId,
      constructorId: poolAssets.constructorId,
      familyName: drivers.familyName,
      displayName: drivers.displayName,
      driverCode: drivers.code,
      constructorName: constructors.name,
    })
    .from(poolAssets)
    .leftJoin(drivers, eq(drivers.id, poolAssets.driverId))
    .leftJoin(constructors, eq(constructors.id, poolAssets.constructorId))
    .where(
      and(eq(poolAssets.gameId, input.gameId), inArray(poolAssets.id, ids)),
    );
  const look = new Map(
    event
      ? (
          await db
            .select({
              constructorId: constructorSeasons.constructorId,
              name: constructorSeasons.displayName,
              shortName: constructorSeasons.shortName,
              color: constructorSeasons.color,
            })
            .from(constructorSeasons)
            .where(eq(constructorSeasons.seasonId, event.seasonId))
        ).map((row) => [row.constructorId, row])
      : [],
  );
  const driverIds = assets.flatMap((a) => (a.driverId ? [a.driverId] : []));
  const carOf = new Map(
    driverIds.length === 0
      ? []
      : (
          await db
            .select({
              driverId: eventEntries.driverId,
              constructorId: eventEntries.constructorId,
            })
            .from(eventEntries)
            .where(
              and(
                eq(eventEntries.eventId, input.eventId),
                inArray(eventEntries.driverId, driverIds),
              ),
            )
        ).map((row) => [row.driverId, row.constructorId]),
  );
  return new Map(
    assets.map((asset): [string, Look] => {
      if (asset.kind === "driver") {
        const team = asset.driverId
          ? look.get(carOf.get(asset.driverId) ?? "")
          : undefined;
        const name = asset.familyName ?? asset.displayName ?? "";
        return [
          asset.id,
          {
            kind: "driver",
            title: name,
            code: asset.driverCode ?? name.slice(0, 3).toUpperCase(),
            color: team?.color ?? GREY,
          },
        ];
      }
      const team = asset.constructorId
        ? look.get(asset.constructorId)
        : undefined;
      return [
        asset.id,
        {
          kind: "constructor",
          title: team?.name ?? asset.constructorName ?? "",
          code: constructorCode(team?.shortName ?? asset.constructorName ?? ""),
          color: team?.color ?? GREY,
        },
      ];
    }),
  );
}

type AssetLines = {
  points: number;
  lines: SheetLine[];
  /** For the row's reason. */
  raw: Array<{ ruleCode: string; detail: unknown }>;
};

/**
 * The asset lines of some assets in some sessions, in words: session id to
 * asset id to its lines. A constructor's line from one of its drivers names
 * the driver, and counts as "Both drivers" in the row's reason.
 */
async function assetLinesOf(
  db: Db,
  input: { gameId: string; sessionIds: string[]; assetIds: string[] },
): Promise<Map<string, Map<string, AssetLines>>> {
  const out = new Map<string, Map<string, AssetLines>>();
  if (input.sessionIds.length === 0 || input.assetIds.length === 0) return out;
  const rows = await db
    .select({
      sessionId: assetScoreLines.sessionId,
      sessionKind: sessions.kind,
      assetId: assetScoreLines.assetId,
      ruleCode: assetScoreLines.ruleCode,
      points: assetScoreLines.points,
      detail: assetScoreLines.detail,
      subject: drivers.familyName,
    })
    .from(assetScoreLines)
    .innerJoin(sessions, eq(sessions.id, assetScoreLines.sessionId))
    .leftJoin(drivers, eq(drivers.id, assetScoreLines.subjectDriverId))
    .where(
      and(
        eq(assetScoreLines.gameId, input.gameId),
        inArray(assetScoreLines.sessionId, input.sessionIds),
        inArray(assetScoreLines.assetId, [...new Set(input.assetIds)]),
      ),
    )
    .orderBy(
      asc(assetScoreLines.assetId),
      asc(drivers.familyName),
      asc(assetScoreLines.ruleCode),
    );
  for (const row of rows) {
    const bySession = out.get(row.sessionId) ?? new Map<string, AssetLines>();
    out.set(row.sessionId, bySession);
    const entry = bySession.get(row.assetId) ?? {
      points: 0,
      lines: [],
      raw: [],
    };
    bySession.set(row.assetId, entry);
    const words = sheetWords(row.ruleCode, row.detail);
    entry.points += row.points;
    entry.lines.push({
      label: row.subject ? `${row.subject} · ${words.label}` : words.label,
      why: words.why,
      points: row.points,
    });
    entry.raw.push(
      row.subject
        ? { ruleCode: `${row.sessionKind}.drivers`, detail: {} }
        : { ruleCode: row.ruleCode, detail: row.detail },
    );
  }
  return out;
}

/** The lineup that counted in each session: the Late Call one from its session on. */
async function picksBySession(
  db: Db,
  input: { teamId: string; eventId: string; sessionIds: string[] },
): Promise<Map<string, Array<{ assetId: string; isBoost: boolean }>>> {
  const out = new Map<string, Array<{ assetId: string; isBoost: boolean }>>();
  if (input.sessionIds.length === 0) return out;
  const { rows } = (await db.execute(sql`
    select se.id as session_id, p.asset_id, p.is_boost
    from ${teamEventStates} s
    join ${sessions} se on se.event_id = s.event_id
    left join lineup_versions ff on ff.id = s.final_fix_version_id
    left join ${sessions} ffs on ffs.id = ff.effective_from_session_id
    join lineup_picks p on p.lineup_version_id = case
      when ffs.id is not null
       and (se.scheduled_start, se.id) >= (ffs.scheduled_start, ffs.id)
      then ff.id else s.locked_version_id end
    where s.team_id = ${input.teamId}::uuid
      and s.event_id = ${input.eventId}::uuid
      and se.id in (${sql.join(
        input.sessionIds.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
  `)) as {
    rows: Array<{ session_id: string; asset_id: string; is_boost: boolean }>;
  };
  for (const row of rows) {
    const list = out.get(row.session_id) ?? [];
    list.push({ assetId: row.asset_id, isBoost: row.is_boost });
    out.set(row.session_id, list);
  }
  return out;
}

/** The scored sessions of an event, in order. */
async function scoredSessionsOf(db: Db, eventId: string) {
  return db
    .select({ id: sessions.id, kind: sessions.kind })
    .from(sessions)
    .where(
      and(
        eq(sessions.eventId, eventId),
        inArray(sessions.kind, [...SCORED_KINDS]),
      ),
    )
    .orderBy(asc(sessions.scheduledStart), asc(sessions.sequence));
}

/**
 * One team's points at one event, by session (M6 Task 11): the latest event
 * it has points for, or `round`. Null when it has none there. `show`
 * reveals sessions this once ("Show it"); it is never stored.
 */
export async function teamBreakdown(
  db: Db,
  now: Date,
  input: {
    teamId: string;
    reader: NonNullable<Reader>;
    round?: number;
    show?: string[];
  },
): Promise<Breakdown | null> {
  const { teamId, reader } = input;
  const [team] = await db
    .select({
      id: teams.id,
      slot: teams.slot,
      name: teams.name,
      gameId: teams.gameId,
    })
    .from(teams)
    .where(eq(teams.id, teamId));
  if (!team) return null;

  const totals = await db
    .select({
      eventId: teamEventTotals.eventId,
      round: events.round,
      name: events.name,
      points: teamEventTotals.points,
      bySession: teamEventTotals.pointsBySession,
      status: teamEventTotals.status,
    })
    .from(teamEventTotals)
    .innerJoin(events, eq(events.id, teamEventTotals.eventId))
    .where(eq(teamEventTotals.teamId, teamId))
    .orderBy(asc(teamEventTotals.eventSequence));
  const at =
    input.round === undefined
      ? totals.at(-1)
      : totals.find((t) => t.round === input.round);
  if (!at) return null;

  const eventSessions = await scoredSessionsOf(db, at.eventId);
  const ids = eventSessions.map((s) => s.id);
  const revealed = await revealedSessions(db, now, reader, ids);
  for (const id of input.show ?? []) if (ids.includes(id)) revealed.add(id);

  const bySession = at.bySession;
  const isScored = (id: string) => typeof bySession[id] === "number";
  const open = ids.filter((id) => isScored(id) && revealed.has(id));
  const allShown =
    ids.some(isScored) && ids.every((id) => !isScored(id) || revealed.has(id));

  const picks = await picksBySession(db, {
    teamId,
    eventId: at.eventId,
    sessionIds: open,
  });
  const adjustments = await db
    .select({
      sessionId: teamAdjustmentLines.sessionId,
      assetId: teamAdjustmentLines.assetId,
      lineType: teamAdjustmentLines.lineType,
      category: teamAdjustmentLines.category,
      points: teamAdjustmentLines.points,
    })
    .from(teamAdjustmentLines)
    .where(
      and(
        eq(teamAdjustmentLines.teamId, teamId),
        eq(teamAdjustmentLines.eventId, at.eventId),
      ),
    )
    .orderBy(asc(teamAdjustmentLines.lineType));
  const shownAdjustments = adjustments.filter((a) =>
    a.sessionId === null ? allShown : open.includes(a.sessionId),
  );

  const assetIds = [
    ...[...picks.values()].flatMap((list) => list.map((p) => p.assetId)),
    ...shownAdjustments.flatMap((a) => (a.assetId ? [a.assetId] : [])),
  ];
  const looks = await looksOf(db, {
    gameId: team.gameId,
    eventId: at.eventId,
    assetIds,
  });
  const lines = await assetLinesOf(db, {
    gameId: team.gameId,
    sessionIds: open,
    assetIds,
  });

  const kindOf = new Map(eventSessions.map((s) => [s.id, s.kind]));
  const labelOf = (id: string) => SESSION_LABELS[kindOf.get(id) ?? ""] ?? "";

  const list: BreakdownSession[] = eventSessions.map((s) => {
    const scored = isScored(s.id);
    const shown = revealed.has(s.id);
    const base = {
      id: s.id,
      label: labelOf(s.id),
      scored,
      revealed: shown,
    };
    if (!scored || !shown) return { ...base, points: null, rows: [] };
    const sessionLines = lines.get(s.id) ?? new Map<string, AssetLines>();
    const rows: BreakdownRow[] = (picks.get(s.id) ?? []).map((pick) => {
      const look = looks.get(pick.assetId);
      const mine = sessionLines.get(pick.assetId);
      const badges = adjustments
        .filter((a) => a.sessionId === s.id && a.assetId === pick.assetId)
        .flatMap((a) =>
          a.lineType === "boost"
            ? ["2×"]
            : a.lineType === "triple_boost"
              ? ["3×"]
              : [],
        );
      if (pick.isBoost && !badges.includes("2×")) badges.unshift("2×");
      return {
        assetId: pick.assetId,
        kind: look?.kind ?? "driver",
        title: look?.title ?? "",
        code: look?.code ?? "",
        color: look?.color ?? GREY,
        points: mine?.points ?? 0,
        reason: rowReason(mine?.raw ?? []),
        badges,
        lines: mine?.lines ?? [],
      };
    });
    rows.sort(
      (a, b) =>
        (a.kind === b.kind ? 0 : a.kind === "driver" ? -1 : 1) ||
        b.points - a.points ||
        a.title.localeCompare(b.title),
    );
    return { ...base, points: bySession[s.id]!, rows };
  });

  // The transfer penalty's words need the lock record's counts.
  const [record] = await db
    .select({
      made: teamEventStates.transfersMade,
      free: teamEventStates.freeTransfers,
    })
    .from(teamEventStates)
    .where(
      and(
        eq(teamEventStates.teamId, teamId),
        eq(teamEventStates.eventId, at.eventId),
      ),
    );
  const extras: BreakdownExtra[] = shownAdjustments.map((a) => {
    const name = a.assetId ? (looks.get(a.assetId)?.title ?? "") : "";
    const session = a.sessionId ? labelOf(a.sessionId).toLowerCase() : "";
    const words = ((): { label: string; why: string } => {
      switch (a.lineType) {
        case "boost":
          return {
            label: `2× Boost · ${name}`,
            why: `Doubles the ${session} points`,
          };
        case "triple_boost":
          return {
            label: `Overdrive · ${name}`,
            why: `Triples the ${session} points`,
          };
        case "no_negative":
          return {
            label: `Safety Car · ${name}`,
            why: `${categoryWords(a.category)} back to zero`,
          };
        case "autopilot_remove":
          return {
            label: `Strategist · ${name}`,
            why: "Your Boost moved off",
          };
        case "autopilot_add":
          return {
            label: `Strategist · ${name}`,
            why: "Your Boost moved to your top scorer",
          };
        case "transfer_penalty": {
          const made = record?.made ?? 0;
          const free = record?.free;
          return {
            label: "Transfer penalty",
            why:
              free === null || free === undefined
                ? `${made} ${made === 1 ? "transfer" : "transfers"}`
                : `${made} ${made === 1 ? "transfer" : "transfers"}, ${free} ${free === 1 ? "was" : "were"} free`,
          };
        }
      }
    })();
    return {
      kind: a.lineType,
      sessionId: a.sessionId,
      assetId: a.assetId,
      ...words,
      points: a.points,
    };
  });
  // By session in order, then the event-level lines.
  const order = (id: string | null) =>
    id === null ? ids.length : ids.indexOf(id);
  extras.sort((a, b) => order(a.sessionId) - order(b.sessionId));

  // The correction note, from each revealed session's runs.
  const runs = open.length
    ? await db
        .select({
          sessionId: scoringRuns.sessionId,
          trigger: scoringRuns.trigger,
          isCurrent: scoringRuns.isCurrent,
        })
        .from(scoringRuns)
        .where(
          and(
            eq(scoringRuns.gameId, team.gameId),
            inArray(scoringRuns.sessionId, open),
            eq(scoringRuns.mode, "live"),
            eq(scoringRuns.status, "succeeded"),
          ),
        )
    : [];
  const correction = correctionNote(
    open.map((id) => {
      const mine = runs.filter((r) => r.sessionId === id);
      return {
        label: labelOf(id),
        runs: mine.length,
        trigger: mine.find((r) => r.isCurrent)?.trigger ?? null,
      };
    }),
  );

  return {
    team: { id: team.id, slot: team.slot, name: team.name },
    event: { id: at.eventId, name: at.name, round: at.round },
    rounds: totals.map((t) => t.round),
    status: at.status,
    total: allShown ? at.points : null,
    correction,
    sessions: list,
    extras,
  };
}

/** One asset's lines at an event, session by session. */
export type AssetSheet = {
  title: string;
  sessions: Array<{
    id: string;
    label: string;
    revealed: boolean;
    /** Null while hidden. */
    points: number | null;
    lines: SheetLine[];
  }>;
};

/**
 * The driver sheet's lines for one asset at an event: each scored session's
 * lines, line by line, only where the reader may see them. They add up to
 * the asset's row in the breakdown.
 */
export async function assetSheet(
  db: Db,
  now: Date,
  input: {
    gameId: string;
    assetId: string;
    eventId: string;
    reader: Reader;
  },
): Promise<AssetSheet> {
  const eventSessions = await scoredSessionsOf(db, input.eventId);
  const ids = eventSessions.map((s) => s.id);
  const revealed = await revealedSessions(db, now, input.reader, ids);
  const open = ids.filter((id) => revealed.has(id));
  const lines = await assetLinesOf(db, {
    gameId: input.gameId,
    sessionIds: open,
    assetIds: [input.assetId],
  });
  const look = (
    await looksOf(db, {
      gameId: input.gameId,
      eventId: input.eventId,
      assetIds: [input.assetId],
    })
  ).get(input.assetId);
  return {
    title: look?.title ?? "",
    sessions: eventSessions.map((s) => {
      const shown = revealed.has(s.id);
      const mine = shown ? lines.get(s.id)?.get(input.assetId) : undefined;
      return {
        id: s.id,
        label: SESSION_LABELS[s.kind] ?? s.kind,
        revealed: shown,
        points: shown ? (mine?.points ?? 0) : null,
        lines: mine?.lines ?? [],
      };
    }),
  };
}

// --- Server-function body ----------------------------------------------------

export const getBreakdownInput = z.object({
  slot: z.number().int().min(1).max(10),
  round: z.number().int().min(1).max(30).optional(),
  /** Sessions to show this once ("Show it", the page's `?show=`). */
  show: z.array(z.uuid()).max(10).optional(),
});

export type BreakdownPage = {
  team: { slot: number; name: string };
  /** Null before the team has any points. */
  breakdown: Breakdown | null;
};

/** `/team/$slot/points` for the viewer's active team in that slot. */
export async function breakdownForSlot(
  db: Db,
  now: Date,
  viewer: Viewer | null,
  data: z.infer<typeof getBreakdownInput>,
): Promise<BreakdownPage> {
  const v = requireComplete(viewer);
  const game = await currentGame(db);
  if (!game) throw new GameError("game_not_open", "no game is open");
  const [team] = await db
    .select({ id: teams.id, name: teams.name, status: teams.status })
    .from(teams)
    .where(
      and(
        eq(teams.gameId, game.id),
        eq(teams.userId, v.userId),
        eq(teams.slot, data.slot),
        eq(teams.status, "active"),
      ),
    );
  if (!team) throw new GameError("team_not_owned", "no team in that slot");
  const breakdown = await teamBreakdown(db, now, {
    teamId: team.id,
    reader: readerOf(v)!,
    round: data.round,
    show: data.show,
  });
  return { team: { slot: data.slot, name: team.name }, breakdown };
}
