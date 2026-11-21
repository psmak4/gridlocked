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
import { enqueueCalendarSync } from "@/jobs/sync-calendar";
import type { TickDb } from "@/jobs/tick";
import { staffArea, type StaffArea } from "@/staff/area";
import {
  calendarList,
  calendarSeason,
  cancelEvent,
  eventDetail,
  followLockSession,
  setLockAt,
  setSessionStatus,
  setSessionTimes,
  STAFF_SESSION_STATUSES,
} from "@/staff/calendar";
import { REASON_MAX, StaffError } from "@/staff/errors";
import { staffTime } from "@/staff/time";
import { webDueStore } from "./due-store";
import { getViewer } from "./session";
import { staffActor, staffFn, staffInput } from "./staff-fn";

/**
 * Who is in the staff area, for the layout's guard and the menu. Not a
 * `staffFn`: a locked session gets an answer too, so the guard can send it
 * to the security page rather than show an error.
 */
export const getStaffArea = createServerFn({ method: "GET" }).handler(
  async (): Promise<StaffArea> => {
    setResponseHeader("Cache-Control", "private, no-store");
    return staffArea(await getViewer(getRequest()));
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

const reasonText = z.string().max(REASON_MAX);
const instant = z.iso.datetime().transform((s) => new Date(s));

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
  .handler(
    staffFn({
      role: "admin",
      input: z.strictObject({ season: z.number().int().min(1950).max(2100) }),
      handler: async ({ db, now }, input) => {
        const store = await webDueStore();
        const { created } = await enqueueCalendarSync(
          db as TickDb,
          now,
          input.season,
          store ?? undefined,
        );
        return { created };
      },
    }),
  );

/** The panel's lock: follow the session, or a time set by hand. */
export const saveLock = createServerFn({ method: "POST" })
  .validator(staffInput)
  .handler(
    staffFn({
      role: "admin",
      input: z.discriminatedUnion("mode", [
        z.strictObject({
          mode: z.literal("follow"),
          eventId: z.uuid(),
          reason: reasonText,
        }),
        z.strictObject({
          mode: z.literal("hand"),
          eventId: z.uuid(),
          lockAt: instant,
          reason: reasonText,
        }),
      ]),
      handler: async ({ db, now, viewer, requestId }, input) => {
        const actor = staffActor(viewer, requestId);
        const store = (await webDueStore()) ?? undefined;
        if (input.mode === "hand") {
          await setLockAt(db, now, actor, input, store);
        } else {
          await followLockSession(db, now, actor, input, store);
        }
        return null;
      },
    }),
  );

/** A session's times and status, each saved only if it changed. */
export const saveSession = createServerFn({ method: "POST" })
  .validator(staffInput)
  .handler(
    staffFn({
      role: "admin",
      input: z.strictObject({
        sessionId: z.uuid(),
        start: instant.optional(),
        end: instant.optional(),
        status: z.enum(STAFF_SESSION_STATUSES).optional(),
        reason: reasonText,
      }),
      handler: async ({ db, now, viewer, requestId }, input) => {
        const actor = staffActor(viewer, requestId);
        const store = (await webDueStore()) ?? undefined;
        const { sessionId, reason } = input;
        if (!input.start !== !input.end) throw new StaffError("invalid");
        if (!input.start && !input.status) throw new StaffError("invalid");
        if (input.start && input.end) {
          await setSessionTimes(
            db,
            now,
            actor,
            { sessionId, start: input.start, end: input.end, reason },
            store,
          );
        }
        if (input.status) {
          await setSessionStatus(
            db,
            now,
            actor,
            { sessionId, status: input.status, reason },
            store,
          );
        }
        return null;
      },
    }),
  );

/** Mark cancelled: an event called off before its lock. */
export const cancelCalendarEvent = createServerFn({ method: "POST" })
  .validator(staffInput)
  .handler(
    staffFn({
      role: "admin",
      input: z.strictObject({ eventId: z.uuid(), reason: reasonText }),
      handler: async ({ db, now, viewer, requestId }, input) => {
        await cancelEvent(
          db,
          now,
          staffActor(viewer, requestId),
          input,
          (await webDueStore()) ?? undefined,
        );
        return null;
      },
    }),
  );
