/**
 * The staff screens' server functions (M8). Each one is a `createServerFn`
 * whose handler is `staffFn`, so it runs `requireStaff` at its role before
 * its input is parsed, and answers `{ ok, value | error }`. The work is in
 * `src/staff/`, tested on a database without the Start runtime. Every task
 * adds its own functions here.
 */
import { createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import { AUDIT_GROUPS, type AuditGroup } from "@/audit/actions";
import { auditActors, auditPage } from "@/audit/read";
import { staffArea, type StaffArea } from "@/staff/area";
import { calendarList, calendarSeason, eventDetail } from "@/staff/calendar";
import {
  availabilityFor,
  nextEventId,
  seasonDrivers,
  seatEvents,
  seatTable,
} from "@/staff/availability";
import { StaffError } from "@/staff/errors";
import { correctionSummary } from "@/staff/result-words";
import { dryRunSummary, rulesetVersions, scoringGame } from "@/staff/scoring";
import { modItem, modQueue } from "@/community/queue-read";
import { nextPrices } from "@/staff/prices";
import * as USERS from "./staff-users";
import * as WRITES from "./staff-writes";
import { getSetting } from "@/settings";
import { clockModeFromEnv } from "@/lib/resolve-clock";
import { usageMeters } from "@/staff/usage";
import { openReviewCount, reviewItem, reviewList } from "@/staff/review";
import { sessionResults } from "@/staff/session-results";
import { staffTime } from "@/staff/time";
import { getViewer, withRequestNow } from "./session";
import { staffFn, staffInput } from "./staff-fn";

/**
 * Who is in the staff area, for the layout's guard and the menu. Not a
 * `staffFn`: a locked session gets an answer too, so the guard can send it
 * to the security page rather than show an error.
 */
export const getStaffArea = createServerFn({ method: "GET" }).handler(
  async (): Promise<StaffArea> => {
    setResponseHeader("Cache-Control", "private, no-store");
    const area = staffArea(await getViewer(getRequest()));
    if (area.state !== "open") return area;
    return withRequestNow(async (db) => ({
      ...area,
      counts: {
        moderation: (await modQueue(db, { tab: "open" })).length,
        ...(area.role === "admin" ? { review: await openReviewCount(db) } : {}),
      },
    }));
  },
);

// --- The audit log (Task 4) --------------------------------------------------

export const auditInput = z.strictObject({
  who: z.union([z.literal("jobs"), z.uuid()]).optional(),
  group: z
    .enum(Object.keys(AUDIT_GROUPS) as [AuditGroup, ...AuditGroup[]])
    .optional(),
  before: z.uuid().optional(),
});
export type AuditInput = z.infer<typeof auditInput>;

/** A page of the audit log, with each row's time in the viewer's zone. */
export const getAuditLog = createServerFn({ method: "GET" })
  .validator(staffInput)
  .handler(
    staffFn({
      role: "admin",
      input: auditInput,
      handler: async ({ db, now, viewer }, input) => {
        const page = await auditPage(db, input);
        return {
          rows: page.rows.map((row) => ({
            ...row,
            whenLabel: staffTime(
              new Date(row.when),
              viewer.profile.timezone,
              now,
            ),
          })),
          next: page.next,
          actors: await auditActors(db),
        };
      },
    }),
  );

// --- The calendar (Task 5) ---------------------------------------------------

export const calendarInput = z.strictObject({
  season: z.number().int().min(1950).max(2100).optional(),
});

/** The season's calendar: the active season unless another is asked for. */
export const getCalendar = createServerFn({ method: "GET" })
  .validator(staffInput)
  .handler(
    staffFn({
      role: "admin",
      input: calendarInput,
      handler: async ({ db, now, viewer }, input) => {
        const list = await calendarList(
          db,
          now,
          input.season ?? (await calendarSeason(db, now)),
        );
        return {
          ...list,
          syncedLabel: list.syncedAt
            ? staffTime(new Date(list.syncedAt), viewer.profile.timezone, now)
            : null,
        };
      },
    }),
  );

/** One event for the editing panel, its History in the viewer's zone. */
export const getCalendarEvent = createServerFn({ method: "GET" })
  .validator(staffInput)
  .handler(
    staffFn({
      role: "admin",
      input: z.strictObject({ eventId: z.uuid() }),
      handler: async ({ db, now, viewer }, input) => {
        const detail = await eventDetail(db, now, input.eventId);
        return {
          ...detail,
          history: detail.history.map((row) => ({
            ...row,
            whenLabel: staffTime(
              new Date(row.when),
              viewer.profile.timezone,
              now,
            ),
          })),
        };
      },
    }),
  );

/** Sync now: the season's calendar sync, due at once. */
export const syncCalendarNow = createServerFn({ method: "POST" })
  .validator(staffInput)
  .handler(staffFn(WRITES.SYNC_CALENDAR_NOW));

/** The panel's lock: follow the session, or a time set by hand. */
export const saveLock = createServerFn({ method: "POST" })
  .validator(staffInput)
  .handler(staffFn(WRITES.SAVE_LOCK));

/** A session's times and status, each saved only if it changed. */
export const saveSession = createServerFn({ method: "POST" })
  .validator(staffInput)
  .handler(staffFn(WRITES.SAVE_SESSION));

/** Mark cancelled: an event called off before its lock. */
export const cancelCalendarEvent = createServerFn({ method: "POST" })
  .validator(staffInput)
  .handler(staffFn(WRITES.CANCEL_CALENDAR_EVENT));

// --- Drivers, seats and availability (Task 6) -------------------------------

export const seatsInput = z.strictObject({
  team: z
    .string()
    .regex(/^[a-z0-9-]{1,64}$/)
    .optional(),
  event: z.uuid().optional(),
});
export type SeatsInput = z.infer<typeof seatsInput>;

/** The seat table (one team's tab, or all), the forms' choices, and availability. */
export const getSeats = createServerFn({ method: "GET" })
  .validator(staffInput)
  .handler(
    staffFn({
      role: "admin",
      input: seatsInput,
      handler: async ({ db, now }, input) => {
        const season = await calendarSeason(db, now);
        const eventId = input.event ?? (await nextEventId(db, now, season));
        return {
          table: await seatTable(db, season, input.team),
          events: await seatEvents(db, now, season),
          drivers: await seasonDrivers(db, season),
          availability: eventId
            ? await availabilityFor(db, now, eventId)
            : null,
        };
      },
    }),
  );

/** Move a driver from a date: one `changeSeats` change. */
export const moveDriver = createServerFn({ method: "POST" })
  .validator(staffInput)
  .handler(staffFn(WRITES.MOVE_DRIVER));

/** Add a new driver: a substitution for one event (`recordSubstitution`). */
export const addDriver = createServerFn({ method: "POST" })
  .validator(staffInput)
  .handler(staffFn(WRITES.ADD_DRIVER));

/** One driver's availability for an event; the note players see is the reason. */
export const saveAvailability = createServerFn({ method: "POST" })
  .validator(staffInput)
  .handler(staffFn(WRITES.SAVE_AVAILABILITY));

// --- Session results and corrections (Task 7) -------------------------------

/** One session's results board, its times in the viewer's zone. */
export const getSessionResults = createServerFn({ method: "GET" })
  .validator(staffInput)
  .handler(
    staffFn({
      role: "admin",
      input: z.strictObject({ sessionId: z.uuid() }),
      handler: async ({ db, now, viewer }, input) => {
        const view = await sessionResults(db, input.sessionId);
        if (!view) throw new StaffError("not_found");
        const zone = viewer.profile.timezone;
        return {
          ...view,
          source: view.source && {
            kind: view.source.kind,
            provider: view.source.provider,
            lastCheckedLabel: view.source.lastCheckedAt
              ? staffTime(view.source.lastCheckedAt, zone, now)
              : null,
          },
          changes: view.changes.map((c) => ({
            id: c.id,
            driverId: c.driverId,
            what: c.what,
            whenLabel: staffTime(c.detectedAt, zone, now),
          })),
          overrides: view.overrides.map((o) => ({
            id: o.id,
            driverId: o.driverId,
            driver: o.driver,
            kind: o.kind,
            summary: correctionSummary(o.kind, o.fields),
            reason: o.reason,
            active: o.active,
            whenLabel: staffTime(o.createdAt, zone, now),
            revokedLabel: o.revokedAt
              ? staffTime(o.revokedAt, zone, now)
              : null,
          })),
        };
      },
    }),
  );

/** Add a correction: one change to one driver's row, re-scoring the session. */
export const saveCorrection = createServerFn({ method: "POST" })
  .validator(staffInput)
  .handler(staffFn(WRITES.SAVE_CORRECTION));

/** Revoke a correction, so the driver goes back to the provider's row. */
export const revokeCorrection = createServerFn({ method: "POST" })
  .validator(staffInput)
  .handler(staffFn(WRITES.REVOKE_CORRECTION));

/** Check provider again: the session's next poll, due at once. */
export const checkProvider = createServerFn({ method: "POST" })
  .validator(staffInput)
  .handler(staffFn(WRITES.CHECK_PROVIDER));

// --- Scoring: the dry run, approval and ruleset versions (Task 8) -----------

/** The scoring board: the game, its latest dry run and its ruleset versions. */
export const getScoring = createServerFn({ method: "GET" })
  .validator(staffInput)
  .handler(
    staffFn({
      role: "admin",
      input: z.strictObject({}),
      handler: async ({ db, now, viewer }) => {
        const game = await scoringGame(db);
        if (!game) return { game: null, dryRun: null, versions: [] };
        const zone = viewer.profile.timezone;
        const summary = await dryRunSummary(db, game.id);
        const versions = await rulesetVersions(db, game.id);
        return {
          game,
          dryRun: summary && {
            ...withoutKey(summary, "startedAt"),
            startedLabel: staffTime(summary.startedAt, zone, now),
          },
          versions: versions.map((v) => ({
            ...withoutKey(v, "publishedAt"),
            publishedLabel: staffTime(v.publishedAt, zone, now),
          })),
        };
      },
    }),
  );

function withoutKey<T extends object, K extends keyof T>(
  value: T,
  key: K,
): Omit<T, K> {
  const rest = { ...value };
  delete rest[key];
  return rest;
}

/** Start a dry run: what re-scoring the whole game would change. */
export const startScoringDryRun = createServerFn({ method: "POST" })
  .validator(staffInput)
  .handler(staffFn(WRITES.START_SCORING_DRY_RUN));

/** Approve and re-score, naming the dry run the board showed. */
export const approveScoring = createServerFn({ method: "POST" })
  .validator(staffInput)
  .handler(staffFn(WRITES.APPROVE_SCORING));

/** Discard the dry run: nothing is re-scored. */
export const discardScoring = createServerFn({ method: "POST" })
  .validator(staffInput)
  .handler(staffFn(WRITES.DISCARD_SCORING));

// --- Prices: the next event's list, and one price set by hand (Task 9) -------

/** The prices screen: the next event's list with each asset's inputs. */
export const getPrices = createServerFn({ method: "GET" })
  .validator(staffInput)
  .handler(
    staffFn({
      role: "admin",
      input: z.strictObject({}),
      handler: async ({ db }) => {
        const game = await scoringGame(db);
        if (!game) return { game: null, prices: null };
        return { game, prices: await nextPrices(db, game.id) };
      },
    }),
  );

/** **Change one by hand**: the new price in $M, to one decimal place. */
export const savePrice = createServerFn({ method: "POST" })
  .validator(staffInput)
  .handler(staffFn(WRITES.SAVE_PRICE));

// --- The review queue (Task 10) ---------------------------------------------

/** The Open or Resolved tab, with labels in the viewer's time zone. */
export const getReviewList = createServerFn({ method: "GET" })
  .validator(staffInput)
  .handler(
    staffFn({
      role: "admin",
      input: z.strictObject({ tab: z.enum(["open", "resolved"]) }),
      handler: async ({ db, now, viewer }, { tab }) => {
        const zone = viewer.profile.timezone;
        const items = await reviewList(db, { status: tab });
        return items.map(({ createdAt, resolvedAt, ...item }) => ({
          ...item,
          whenLabel: staffTime(resolvedAt ?? createdAt, zone, now),
        }));
      },
    }),
  );

/** One item: its evidence, what it holds, and its actions. */
export const getReviewItem = createServerFn({ method: "GET" })
  .validator(staffInput)
  .handler(
    staffFn({
      role: "admin",
      input: z.strictObject({ id: z.uuid() }),
      handler: async ({ db, now, viewer }, { id }) => {
        const item = await reviewItem(db, id);
        if (!item) throw new StaffError("not_found");
        const { createdAt, resolvedAt, ...rest } = item;
        const zone = viewer.profile.timezone;
        return {
          ...rest,
          openedLabel: staffTime(createdAt, zone, now),
          resolvedLabel: resolvedAt ? staffTime(resolvedAt, zone, now) : null,
        };
      },
    }),
  );

/** Resolve an item with one of its actions, at the version the screen read. */
export const resolveReview = createServerFn({ method: "POST" })
  .validator(staffInput)
  .handler(staffFn(WRITES.RESOLVE_REVIEW));

// --- The moderation queue (Task 11) -----------------------------------------

/** A tab of the queue: Open, Auto-hidden or Done (50 a page). */
export const getModQueue = createServerFn({ method: "GET" })
  .validator(staffInput)
  .handler(
    staffFn({
      role: "moderator",
      input: z.strictObject({
        tab: z.enum(["open", "hidden", "done"]),
        before: z.uuid().optional(),
      }),
      handler: async ({ db, now, viewer }, input) =>
        (await modQueue(db, input)).map(({ createdAt, ...item }) => ({
          ...item,
          ageLabel: staffTime(createdAt, viewer.profile.timezone, now),
        })),
    }),
  );

/** One item: the snapshot at first report, the reports, the author. */
export const getModItem = createServerFn({ method: "GET" })
  .validator(staffInput)
  .handler(
    staffFn({
      role: "moderator",
      input: z.strictObject({ id: z.uuid() }),
      handler: async ({ db, now, viewer }, { id }) => {
        const item = await modItem(db, id);
        if (!item) throw new StaffError("not_found");
        const { createdAt, resolvedAt, ...rest } = item;
        const zone = viewer.profile.timezone;
        return {
          ...rest,
          ageLabel: staffTime(createdAt, zone, now),
          postedLabel: staffTime(new Date(item.snapshot.postedAt), zone, now),
          resolvedLabel: resolvedAt ? staffTime(resolvedAt, zone, now) : null,
        };
      },
    }),
  );

/**
 * One of the item's actions, at the version the screen read, with the note
 * the author sees. The action must be one the item offers.
 */
export const moderateItem = createServerFn({ method: "POST" })
  .validator(staffInput)
  .handler(staffFn(WRITES.MODERATE_ITEM));

// --- Users (Task 12) ---------------------------------------------------------

/** Accounts by username prefix, at most 20; never by email. */
export const getUsers = createServerFn({ method: "GET" })
  .validator(staffInput)
  .handler(staffFn(USERS.FIND_USERS));

/** One user: role, trust, restrictions, recent actions and trust history. */
export const getUser = createServerFn({ method: "GET" })
  .validator(staffInput)
  .handler(staffFn(USERS.USER_DETAIL));

export const saveUserRole = createServerFn({ method: "POST" })
  .validator(staffInput)
  .handler(staffFn(WRITES.STAFF_WRITES.saveUserRole));

export const banAccount = createServerFn({ method: "POST" })
  .validator(staffInput)
  .handler(staffFn(WRITES.STAFF_WRITES.banAccount));

export const unbanAccount = createServerFn({ method: "POST" })
  .validator(staffInput)
  .handler(staffFn(WRITES.STAFF_WRITES.unbanAccount));

export const saveTrustLevel = createServerFn({ method: "POST" })
  .validator(staffInput)
  .handler(staffFn(WRITES.STAFF_WRITES.saveTrustLevel));

export const releaseTrustLock = createServerFn({ method: "POST" })
  .validator(staffInput)
  .handler(staffFn(WRITES.STAFF_WRITES.releaseTrustLock));

export const restrictUser = createServerFn({ method: "POST" })
  .validator(staffInput)
  .handler(staffFn(WRITES.STAFF_WRITES.restrictUser));

export const viewAsUser = createServerFn({ method: "POST" })
  .validator(staffInput)
  .handler(staffFn(WRITES.STAFF_WRITES.viewAsUser));

// --- Settings (Task 13) ------------------------------------------------------

/** The editable settings as they stand. */
export const getStaffSettings = createServerFn({ method: "GET" })
  .validator(staffInput)
  .handler(
    staffFn({
      role: "admin",
      input: z.strictObject({}),
      handler: async ({ db, now }) => ({
        meters: await usageMeters(db, now),
        flags: await getSetting(db, "feature_flags"),
        poll: await getSetting(db, "poll_schedule"),
        finalizer: await getSetting(db, "finalizer_checks"),
        // A hosted replay's clock (M9 Task 5); null on real time.
        replay:
          clockModeFromEnv(process.env) === "replay"
            ? {
                now: now.toISOString(),
                running:
                  (await getSetting(db, "replay_offset")).mode === "running",
              }
            : null,
      }),
    }),
  );

/**
 * The screen's one Save: each key that changed, with the same reason, in
 * one transaction, so a refused value leaves the others as they were.
 */
export const saveStaffSettings = createServerFn({ method: "POST" })
  .validator(staffInput)
  .handler(staffFn(WRITES.SAVE_STAFF_SETTINGS));

/** Pause, resume or jump a hosted replay's clock (M9 Task 5). */
export const moveReplayClock = createServerFn({ method: "POST" })
  .validator(staffInput)
  .handler(staffFn(WRITES.MOVE_REPLAY_CLOCK));
