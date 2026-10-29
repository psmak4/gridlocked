import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { and, asc, count, eq, getTableName } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import {
  circuits,
  constructorSeasons,
  constructors,
  driverAvailability,
  drivers,
  eventEntries,
  events,
  jobs,
  providerIds,
  providerRequests,
  rawSnapshots,
  resultChanges,
  resultOverrides,
  results,
  reviewItems,
  seasons,
  seatAssignments,
  sessionParticipants,
  sessionResultState,
  sessions,
} from "@/db/schema";
import type { Db } from "@/db/types";
import type { Clock } from "@/lib/clock";
import { rosterCheck } from "@/reference/roster-check";
import { syncCalendar } from "@/reference/sync-calendar";
import { syncEventEntries } from "@/reference/sync-event-entries";
import { syncConstructors, syncDrivers } from "@/reference/sync-roster";
import { advanceStatus } from "@/results/status";
import type { SessionKind } from "@/results/types";
import { parseJolpicaCalendar } from "../jolpica/calendar";
import { normalizeJolpicaSession } from "../jolpica/normalize-session";
import {
  parseJolpicaConstructors,
  parseJolpicaDrivers,
} from "../jolpica/roster";
import {
  linkOpenF1Sessions,
  openF1SessionKey,
  parseOpenF1Drivers,
  storeParticipants,
} from "../openf1/participants";
import { jolpicaCalendarRequests } from "../pipeline/jolpica-calendar";
import { jolpicaResultsRequest } from "../pipeline/jolpica-results";
import {
  openF1DriversRequest,
  openF1SessionsRequest,
} from "../pipeline/openf1-participants";
import type { ProviderRequest } from "../http/client";
import { storeSnapshot } from "../snapshots";
import { parseSeatsFile, seedSeats } from "./seats";

const SEASON = 2026;

/** What is in the database after an import, so two runs can be compared. */
export interface ImportReport {
  /** Row count per table (the tables the pipeline and the import write to). */
  rows: Record<string, number>;
  reviewItems: {
    total: number;
    /** Open and blocking: anything above 0 holds a session. */
    openBlocking: number;
    byKind: Record<string, number>;
  };
  /** Scored sessions by result status. */
  sessionStatuses: Record<string, number>;
}

const REPORTED_TABLES: PgTable[] = [
  seasons,
  circuits,
  events,
  sessions,
  drivers,
  constructors,
  constructorSeasons,
  seatAssignments,
  eventEntries,
  driverAvailability,
  providerIds,
  rawSnapshots,
  providerRequests,
  jobs,
  sessionResultState,
  results,
  resultChanges,
  resultOverrides,
  sessionParticipants,
  reviewItems,
];

const RESULTS_FILE = /^r(\d{2})-(results|sprint|qualifying)(?:-empty)?\.json$/;
const PRACTICE_FILE = /^drivers-r(\d{2})-(fp[123])\.json$/;
const RESULT_KINDS: Record<string, SessionKind> = {
  results: "race",
  sprint: "sprint",
  qualifying: "qualifying",
};

interface RecordedSession {
  file: string;
  round: number;
  kind: SessionKind;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

/** The recorded files of a directory that match `pattern`, in name order. */
async function recorded(
  dir: string,
  pattern: RegExp,
  kinds: (name: string) => SessionKind,
  fixed: string[],
): Promise<RecordedSession[]> {
  const found: RecordedSession[] = [];
  for (const file of (await readdir(dir)).sort()) {
    if (fixed.includes(file)) continue;
    const match = pattern.exec(file);
    if (!match) throw new Error(`import: unrecognized fixture ${dir}/${file}`);
    found.push({ file, round: Number(match[1]), kind: kinds(match[2]!) });
  }
  return found;
}

/** Our session for a recorded round and kind, in the season being imported. */
async function sessionOf(db: Db, round: number, kind: SessionKind) {
  const [row] = await db
    .select({
      id: sessions.id,
      eventId: events.id,
      seasonId: events.seasonId,
    })
    .from(sessions)
    .innerJoin(events, eq(events.id, sessions.eventId))
    .innerJoin(seasons, eq(seasons.id, events.seasonId))
    .where(
      and(
        eq(seasons.year, SEASON),
        eq(events.round, round),
        eq(sessions.kind, kind),
      ),
    );
  if (!row) throw new Error(`import: no ${kind} session in round ${round}`);
  return row;
}

async function reportOf(db: Db): Promise<ImportReport> {
  const rows: Record<string, number> = {};
  for (const table of REPORTED_TABLES) {
    const [row] = await db.select({ n: count() }).from(table);
    rows[getTableName(table)] = row!.n;
  }

  const items = await db
    .select({
      kind: reviewItems.kind,
      severity: reviewItems.severity,
      status: reviewItems.status,
    })
    .from(reviewItems);
  const byKind: Record<string, number> = {};
  for (const { kind } of items) byKind[kind] = (byKind[kind] ?? 0) + 1;

  const sessionStatuses: Record<string, number> = {};
  const states = await db
    .select({ status: sessionResultState.status, n: count() })
    .from(sessionResultState)
    .groupBy(sessionResultState.status);
  for (const { status, n } of states) sessionStatuses[status] = n;

  return {
    rows,
    reviewItems: {
      total: items.length,
      openBlocking: items.filter(
        (i) => i.status === "open" && i.severity === "blocking",
      ).length,
      byKind,
    },
    sessionStatuses,
  };
}

/** Stores a recorded body as a raw snapshot and returns its id. */
async function storeRecorded(
  db: Db,
  clock: Clock,
  provider: "jolpica" | "openf1",
  request: ProviderRequest,
  body: unknown,
  link: { seasonId?: string; eventId?: string; sessionId?: string } = {},
): Promise<string> {
  return (
    await storeSnapshot(db, {
      provider,
      ...request,
      body,
      now: clock.now(),
      ...link,
    })
  ).id;
}

/**
 * The reference half of the import: the season's calendar, drivers and
 * constructors from the recorded fixtures (each stored as a raw snapshot and
 * synced), the seats from `seats-2026.json`, and every event's entries. No
 * results and no practice participants. The replay harness runs this to seed
 * a weekend, as the calendar sync and the seat setup would have before it.
 */
export async function importReference2026(
  db: Db,
  clock: Clock,
  fixturesDir: string,
): Promise<{ seasonId: string }> {
  const jolpicaDir = join(fixturesDir, "jolpica", String(SEASON));
  const store = (
    provider: "jolpica" | "openf1",
    request: ProviderRequest,
    body: unknown,
  ) => storeRecorded(db, clock, provider, request, body);

  const requests = jolpicaCalendarRequests(SEASON);
  const calendarBody = await readJson(
    join(fixturesDir, "jolpica", `${SEASON}.json`),
  );
  const calendarId = await store("jolpica", requests.calendar, calendarBody);
  await syncCalendar(db, clock, SEASON, {
    events: parseJolpicaCalendar(calendarBody),
    snapshotId: calendarId,
  });
  const driversBody = await readJson(join(jolpicaDir, "drivers.json"));
  await syncDrivers(db, clock, SEASON, {
    items: parseJolpicaDrivers(driversBody),
    snapshotId: await store("jolpica", requests.drivers, driversBody),
  });
  const constructorsBody = await readJson(
    join(jolpicaDir, "constructors.json"),
  );
  await syncConstructors(db, clock, SEASON, {
    items: parseJolpicaConstructors(constructorsBody),
    snapshotId: await store("jolpica", requests.constructors, constructorsBody),
  });

  const { seasonId } = await seedSeats(
    db,
    clock.now(),
    SEASON,
    parseSeatsFile(await readJson(join(fixturesDir, `seats-${SEASON}.json`))),
  );
  const eventIds = await db
    .select({ id: events.id })
    .from(events)
    .where(eq(events.seasonId, seasonId))
    .orderBy(asc(events.round));
  for (const { id } of eventIds) {
    await syncEventEntries(db, id, clock.now());
  }
  return { seasonId };
}

/**
 * Loads the recorded 2026 fixtures (`fixturesDir` is the root that holds
 * `jolpica/`, `openf1/` and `seats-2026.json`) into `db`, the way the pipeline
 * would have learned them (Task 11a):
 *
 * - every fixture body is stored as a raw snapshot (`storeSnapshot`) under the
 *   endpoint and params live polling uses, so the hashes match;
 * - the calendar, drivers and constructors are synced, the seats are seeded
 *   and every event gets its entries from them;
 * - each recorded session is normalized and its status advanced
 *   (`advanceStatus`): a good one reaches `provisional`, an empty body stays
 *   `awaiting`;
 * - each recorded practice session stores its OpenF1 participants, and the
 *   roster check runs for its event.
 *
 * It does not plan or run jobs, does not call a provider and does not
 * finalize: a session only becomes `final` through the finalizer. `clock`
 * supplies every `now`. Safe to run again: the second run finds the same
 * snapshots, writes no result changes and opens no new review items.
 */
export async function importSeason2026(
  db: Db,
  clock: Clock,
  fixturesDir: string,
): Promise<ImportReport> {
  const jolpicaDir = join(fixturesDir, "jolpica", String(SEASON));
  const openf1Dir = join(fixturesDir, "openf1", String(SEASON));

  // Look at every file first, so a stray one fails before anything is written.
  const resultFiles = await recorded(
    jolpicaDir,
    RESULTS_FILE,
    (name) => RESULT_KINDS[name]!,
    ["drivers.json", "constructors.json"],
  );
  const practiceFiles = await recorded(
    openf1Dir,
    PRACTICE_FILE,
    (name) => name as SessionKind,
    ["sessions.json"],
  );
  resultFiles.sort((a, b) => a.round - b.round || (a.kind < b.kind ? -1 : 1));

  // --- Calendar, drivers, constructors, seats and entries -----------------
  const { seasonId } = await importReference2026(db, clock, fixturesDir);
  const store = (
    provider: "jolpica" | "openf1",
    request: ProviderRequest,
    body: unknown,
    link: { seasonId?: string; eventId?: string; sessionId?: string } = {},
  ) => storeRecorded(db, clock, provider, request, body, link);

  // --- Results ------------------------------------------------------------
  for (const { file, round, kind } of resultFiles) {
    const session = await sessionOf(db, round, kind);
    const request = await jolpicaResultsRequest(db, session.eventId, kind);
    if (request === null) throw new Error(`import: no results for a ${kind}`);
    const body = await readJson(join(jolpicaDir, file));
    const snapshotId = await store("jolpica", request, body, {
      seasonId: session.seasonId,
      eventId: session.eventId,
      sessionId: session.id,
    });
    await normalizeJolpicaSession(
      db,
      clock.now(),
      session.id,
      snapshotId,
      body,
    );
    await advanceStatus(db, clock.now(), session.id);
  }

  // --- Practice participants ----------------------------------------------
  const sessionList = await readJson(join(openf1Dir, "sessions.json"));
  await store("openf1", openF1SessionsRequest(SEASON), sessionList, {
    seasonId,
  });
  await linkOpenF1Sessions(db, clock.now(), sessionList);
  const practiceEvents = new Set<string>();
  for (const { file, round, kind } of practiceFiles) {
    const session = await sessionOf(db, round, kind);
    const key = await openF1SessionKey(db, session.id);
    if (key === null) {
      throw new Error(`import: OpenF1 has no ${kind} matching round ${round}`);
    }
    const body = await readJson(join(openf1Dir, file));
    const snapshotId = await store("openf1", openF1DriversRequest(key), body, {
      seasonId: session.seasonId,
      eventId: session.eventId,
      sessionId: session.id,
    });
    await storeParticipants(
      db,
      clock.now(),
      session.id,
      snapshotId,
      parseOpenF1Drivers(body),
    );
    practiceEvents.add(session.eventId);
  }
  for (const eventId of practiceEvents) {
    await rosterCheck(db, clock.now(), eventId);
  }

  return reportOf(db);
}
