/**
 * One session's results for staff (M8 Task 7, wave 5's results board): the
 * effective rows with what a correction or the provider changed, the
 * provider's changes newest first, the corrections, and how many teams own
 * each driver or their team for the event (the "N teams own …" line). Also
 * **Check provider again**, which queues the session's next poll now. There
 * is no reopen: a correction re-scores a final session (finding 9).
 */
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  constructorSeasons,
  drivers,
  effectiveResults,
  eventEntries,
  events,
  gameEvents,
  games,
  poolAssets,
  rawSnapshots,
  resultChanges,
  resultOverrides,
  sessionResultState,
  sessions,
  teams,
  type CLASSIFICATIONS,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { lockedLineups } from "@/game/lineups";
import { type DueStore, republishIfEarlier } from "@/jobs/due-times";
import {
  POLLED_KINDS,
  pollAttemptKey,
  pollStartKey,
  type PollPayload,
} from "@/jobs/kinds";
import { enqueue } from "@/jobs/queue";
import type { TickDb } from "@/jobs/tick";
import { constructorCode } from "@/play/builder";
import { SESSION_LABELS } from "@/play/weekend";
import { StaffError } from "./errors";

type Classification = (typeof CLASSIFICATIONS)[number];

/** The POS column for a row with no place. */
const NO_PLACE: Record<Classification, string> = {
  classified: "–",
  not_classified: "NC",
  disqualified: "DSQ",
  did_not_start: "DNS",
  did_not_qualify: "DNQ",
  excluded: "EX",
};

/** A `results` column's name in "What changed". */
const FIELD_WORDS: Record<string, string> = {
  position: "position",
  classification: "status",
  provider_status: "status",
  grid: "grid",
  fastest_lap_rank: "fastest lap",
  time_ms: "time",
  laps: "laps",
  q1_ms: "Q1",
  q2_ms: "Q2",
  q3_ms: "Q3",
};

export type SessionResultRow = {
  driverId: string;
  driver: string;
  constructorId: string;
  team: string;
  code: string;
  color: string;
  carNumber: number;
  position: number | null;
  pos: string;
  grid: string;
  status: string;
  classification: Classification;
  fastestLapRank: number | null;
  /** "Corrected", "Up from P9", "Down from P8", "Changed" or "". */
  changed: string;
  overridden: boolean;
  overrideReason: string | null;
};

export type SessionResultChange = {
  id: string;
  driverId: string;
  what: string;
  detectedAt: Date;
};

export type SessionOverride = {
  id: string;
  driverId: string;
  driver: string;
  kind: "patch" | "insert" | "suppress";
  fields: Record<string, unknown>;
  reason: string;
  createdAt: Date;
  revokedAt: Date | null;
  active: boolean;
};

export type SessionResults = {
  session: {
    id: string;
    kind: string;
    label: string;
    cancelled: boolean;
    polled: boolean;
  };
  event: { id: string; round: number; name: string };
  status: "awaiting" | "provisional" | "under_review" | "final";
  source: {
    kind: "provider" | "manual";
    provider: string | null;
    lastCheckedAt: Date | null;
  } | null;
  reopenedCount: number;
  rows: SessionResultRow[];
  changes: SessionResultChange[];
  overrides: SessionOverride[];
  /** Teams owning the driver or their team for the event, by driver id. */
  owners: Record<string, number>;
  /** Drivers entered at the event, for the correction form. */
  entrants: { driverId: string; driver: string; team: string }[];
};

const nameOf = (d: { displayName: string | null; familyName: string }) =>
  d.displayName ?? d.familyName;

/** "Norris: P3 → P1", or "Albon: status Finished → +5 s". */
function changeWords(
  driver: string,
  field: string,
  oldValue: string | null,
  newValue: string | null,
): string {
  if (field === "position" && oldValue !== null && newValue !== null) {
    return `${driver}: P${oldValue} → P${newValue}`;
  }
  const what = FIELD_WORDS[field] ?? field.replaceAll("_", " ");
  return `${driver}: ${what} ${oldValue ?? "–"} → ${newValue ?? "–"}`;
}

/** The CHANGED column: a correction first, then the newest provider change. */
function changedWords(
  overridden: boolean,
  latest: { field: string; oldValue: string | null; newValue: string | null }[],
): string {
  if (overridden) return "Corrected";
  const move = latest.find(
    (c) => c.field === "position" && c.oldValue !== null && c.newValue !== null,
  );
  if (move) {
    return Number(move.newValue) < Number(move.oldValue)
      ? `Up from P${move.oldValue}`
      : `Down from P${move.oldValue}`;
  }
  return latest.length > 0 ? "Changed" : "";
}

/**
 * The board for one session, or null when there is no such session. Rows
 * are the effective results (corrections applied, suppressed rows left out)
 * in finishing order, placeless rows last.
 */
export async function sessionResults(
  db: Db,
  sessionId: string,
): Promise<SessionResults | null> {
  const [session] = await db
    .select({
      id: sessions.id,
      kind: sessions.kind,
      status: sessions.status,
      eventId: events.id,
      round: events.round,
      eventName: events.name,
      seasonId: events.seasonId,
    })
    .from(sessions)
    .innerJoin(events, eq(events.id, sessions.eventId))
    .where(eq(sessions.id, sessionId));
  if (!session) return null;

  const [state] = await db
    .select({
      status: sessionResultState.status,
      source: sessionResultState.source,
      snapshotId: sessionResultState.currentSnapshotId,
      reopenedCount: sessionResultState.reopenedCount,
    })
    .from(sessionResultState)
    .where(eq(sessionResultState.sessionId, sessionId));
  const [snapshot] = state?.snapshotId
    ? await db
        .select({
          provider: rawSnapshots.provider,
          lastSeenAt: rawSnapshots.lastSeenAt,
        })
        .from(rawSnapshots)
        .where(eq(rawSnapshots.id, state.snapshotId))
    : [];

  const teamRows = await db
    .select({
      id: constructorSeasons.constructorId,
      name: constructorSeasons.displayName,
      shortName: constructorSeasons.shortName,
      color: constructorSeasons.color,
    })
    .from(constructorSeasons)
    .where(eq(constructorSeasons.seasonId, session.seasonId));
  const teamById = new Map(teamRows.map((tm) => [tm.id, tm]));

  const resultRows = await db
    .select({
      driverId: effectiveResults.driverId,
      displayName: drivers.displayName,
      familyName: drivers.familyName,
      constructorId: effectiveResults.constructorId,
      carNumber: effectiveResults.carNumber,
      position: effectiveResults.position,
      classification: effectiveResults.classification,
      providerStatus: effectiveResults.providerStatus,
      grid: effectiveResults.grid,
      pitLaneStart: effectiveResults.pitLaneStart,
      fastestLapRank: effectiveResults.fastestLapRank,
      overridden: effectiveResults.overridden,
      overrideReason: effectiveResults.overrideReason,
    })
    .from(effectiveResults)
    .innerJoin(drivers, eq(drivers.id, effectiveResults.driverId))
    .where(eq(effectiveResults.sessionId, sessionId))
    .orderBy(
      sql`${effectiveResults.position} asc nulls last`,
      asc(effectiveResults.carNumber),
    );

  const changeRows = await db
    .select({
      id: resultChanges.id,
      driverId: resultChanges.driverId,
      displayName: drivers.displayName,
      familyName: drivers.familyName,
      field: resultChanges.field,
      oldValue: resultChanges.oldValue,
      newValue: resultChanges.newValue,
      detectedAt: resultChanges.detectedAt,
    })
    .from(resultChanges)
    .innerJoin(drivers, eq(drivers.id, resultChanges.driverId))
    .where(eq(resultChanges.sessionId, sessionId))
    .orderBy(desc(resultChanges.detectedAt), desc(resultChanges.id));

  const overrideRows = await db
    .select({
      id: resultOverrides.id,
      driverId: resultOverrides.driverId,
      displayName: drivers.displayName,
      familyName: drivers.familyName,
      kind: resultOverrides.kind,
      fields: resultOverrides.fields,
      reason: resultOverrides.reason,
      createdAt: resultOverrides.createdAt,
      revokedAt: resultOverrides.revokedAt,
    })
    .from(resultOverrides)
    .innerJoin(drivers, eq(drivers.id, resultOverrides.driverId))
    .where(eq(resultOverrides.sessionId, sessionId))
    .orderBy(desc(resultOverrides.createdAt), desc(resultOverrides.id));

  const entries = await db
    .select({
      driverId: eventEntries.driverId,
      constructorId: eventEntries.constructorId,
      displayName: drivers.displayName,
      familyName: drivers.familyName,
    })
    .from(eventEntries)
    .innerJoin(drivers, eq(drivers.id, eventEntries.driverId))
    .where(eq(eventEntries.eventId, session.eventId))
    .orderBy(asc(drivers.familyName));

  // Each driver's team for the event: their row's, else their entry's.
  const teamOf = new Map<string, string>();
  for (const e of entries) teamOf.set(e.driverId, e.constructorId);
  for (const r of resultRows) teamOf.set(r.driverId, r.constructorId);

  const rows: SessionResultRow[] = resultRows.map((r) => {
    const tm = teamById.get(r.constructorId);
    return {
      driverId: r.driverId,
      driver: nameOf(r),
      constructorId: r.constructorId,
      team: tm?.name ?? "",
      code: tm ? constructorCode(tm.shortName) : "",
      color: tm?.color ?? "",
      carNumber: r.carNumber,
      position: r.position,
      pos:
        r.position !== null ? String(r.position) : NO_PLACE[r.classification],
      grid: r.pitLaneStart
        ? "Pit lane"
        : r.grid !== null
          ? String(r.grid)
          : "–",
      status: r.providerStatus,
      classification: r.classification,
      fastestLapRank: r.fastestLapRank,
      changed: changedWords(
        r.overridden,
        changeRows.filter((c) => c.driverId === r.driverId),
      ),
      overridden: r.overridden,
      overrideReason: r.overrideReason,
    };
  });

  return {
    session: {
      id: session.id,
      kind: session.kind,
      label: SESSION_LABELS[session.kind],
      cancelled: session.status === "cancelled",
      polled: (POLLED_KINDS as readonly string[]).includes(session.kind),
    },
    event: {
      id: session.eventId,
      round: session.round,
      name: session.eventName,
    },
    status: state?.status ?? "awaiting",
    source: state
      ? {
          kind: state.source,
          provider: snapshot?.provider ?? null,
          lastCheckedAt: snapshot?.lastSeenAt ?? null,
        }
      : null,
    reopenedCount: state?.reopenedCount ?? 0,
    rows,
    changes: changeRows.map((c) => ({
      id: c.id,
      driverId: c.driverId,
      what: changeWords(nameOf(c), c.field, c.oldValue, c.newValue),
      detectedAt: c.detectedAt,
    })),
    overrides: overrideRows.map((o) => ({
      id: o.id,
      driverId: o.driverId,
      driver: nameOf(o),
      kind: o.kind,
      fields: o.fields as Record<string, unknown>,
      reason: o.reason,
      createdAt: o.createdAt,
      revokedAt: o.revokedAt,
      active: o.revokedAt === null,
    })),
    owners: await ownersFor(db, session.eventId, teamOf),
    entrants: entries.map((e) => {
      const tm = teamById.get(e.constructorId);
      return { driverId: e.driverId, driver: nameOf(e), team: tm?.name ?? "" };
    }),
  };
}

/**
 * For each driver (with their team for the event), the active teams whose
 * lineup for the event has the driver or that team, across the event's
 * running games. A team owning both counts once.
 */
async function ownersFor(
  db: Db,
  eventId: string,
  teamOf: Map<string, string>,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const driverId of teamOf.keys()) counts[driverId] = 0;
  const gameRows = await db
    .select({ id: games.id })
    .from(gameEvents)
    .innerJoin(games, eq(games.id, gameEvents.gameId))
    .where(
      and(
        eq(gameEvents.eventId, eventId),
        ne(gameEvents.status, "cancelled"),
        inArray(games.status, ["open", "running"]),
      ),
    );
  for (const { id: gameId } of gameRows) {
    const assets = await db
      .select({
        id: poolAssets.id,
        driverId: poolAssets.driverId,
        constructorId: poolAssets.constructorId,
      })
      .from(poolAssets)
      .where(eq(poolAssets.gameId, gameId));
    const byAsset = new Map(assets.map((a) => [a.id, a]));
    const gameTeams = await db
      .select({ id: teams.id })
      .from(teams)
      .where(and(eq(teams.gameId, gameId), eq(teams.status, "active")));
    const lineups = await lockedLineups(db, {
      eventId,
      teamIds: gameTeams.map((tm) => tm.id),
    });
    for (const lineup of lineups.values()) {
      const ownedDrivers = new Set<string>();
      const ownedTeams = new Set<string>();
      for (const pick of lineup.picks) {
        const asset = byAsset.get(pick.assetId);
        if (asset?.driverId) ownedDrivers.add(asset.driverId);
        if (asset?.constructorId) ownedTeams.add(asset.constructorId);
      }
      for (const [driverId, constructorId] of teamOf) {
        if (ownedDrivers.has(driverId) || ownedTeams.has(constructorId)) {
          counts[driverId]! += 1;
        }
      }
    }
  }
  return counts;
}

/**
 * Queues the session's next poll to run now (**Check provider again**): the
 * attempt the poll chain would run next, so a pending one is moved to now
 * and pressing twice queues nothing more (`created: false`). The poll
 * handler then fetches, normalizes and re-scores as usual. With `store`, the
 * due-times file is brought forward so the runner wakes for it.
 *
 * Refuses a final session (`session_final`: the poller ignores one, so a
 * correction is the way), and a session that doesn't exist, is cancelled or
 * isn't polled (`not_found`, `invalid`).
 */
export async function checkProviderAgain(
  db: Db,
  now: Date,
  input: { sessionId: string },
  store?: DueStore,
): Promise<{ created: boolean }> {
  const [session] = await db
    .select({ id: sessions.id, kind: sessions.kind, status: sessions.status })
    .from(sessions)
    .where(eq(sessions.id, input.sessionId));
  if (!session) {
    throw new StaffError("not_found", `no session ${input.sessionId}`);
  }
  if (
    session.status === "cancelled" ||
    !(POLLED_KINDS as readonly string[]).includes(session.kind)
  ) {
    throw new StaffError("invalid", `session ${session.id} isn't polled`);
  }
  const [state] = await db
    .select({
      status: sessionResultState.status,
      pollAttempts: sessionResultState.pollAttempts,
    })
    .from(sessionResultState)
    .where(eq(sessionResultState.sessionId, session.id));
  if (state?.status === "final") throw new StaffError("session_final");

  const attempt = state?.pollAttempts ?? 0;
  const payload: PollPayload = { sessionId: session.id, attempt };
  const { created } = await enqueue(db, {
    kind: "poll_session",
    dedupeKey:
      attempt === 0
        ? pollStartKey(session.id)
        : pollAttemptKey(session.id, attempt),
    runAt: now,
    payload,
  });
  if (store) await republishIfEarlier(db as TickDb, store, now, now);
  return { created };
}
