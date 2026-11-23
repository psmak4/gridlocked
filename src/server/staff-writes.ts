/**
 * Every staff write, as a `staffFn` definition (M8 Task 15), so a test runs
 * each one through the same guard the screens do. `staff.ts` declares the
 * server functions themselves, since Start's compiler names a server function
 * by the place `createServerFn` is called; each POST there hands its
 * definition here to `staffFn`. `STAFF_WRITES` lists them all by that name,
 * and `src/staff/staff-writes.test.ts` checks the list against `staff.ts`.
 */
import { z } from "zod";
import { enqueueCalendarSync } from "@/jobs/sync-calendar";
import type { TickDb } from "@/jobs/tick";
import {
  cancelEvent,
  followLockSession,
  setLockAt,
  setSessionStatus,
  setSessionTimes,
  STAFF_SESSION_STATUSES,
} from "@/staff/calendar";
import { AVAILABILITY_STATUSES, setAvailability } from "@/staff/availability";
import { REASON_MAX, StaffError, staffReason } from "@/staff/errors";
import { correctResult, revokeOverride } from "@/staff/results";
import { CORRECTION_FIELDS } from "@/staff/result-words";
import { changeSeats, recordSubstitution } from "@/staff/roster";
import { approveDryRun, discardGameDryRun, startDryRun } from "@/staff/scoring";
import { moderate, type ModTargetType } from "@/community/moderate";
import { modItem } from "@/community/queue-read";
import { setAdminPrice } from "@/staff/prices";
import * as USERS from "./staff-users";
import { setSetting } from "@/settings/write";
import { publishDueTimes } from "@/jobs/due-times";
import { systemClock } from "@/lib/clock";
import {
  hostedReplayNow,
  jumpReplay,
  pauseReplay,
  resumeReplay,
} from "@/replay/hosted-clock";
import { resolveReviewItem } from "@/staff/review";
import { checkProviderAgain } from "@/staff/session-results";
import { webDueStore } from "./due-store";
import { staffActor, staffDef } from "./staff-fn";

const reasonText = z.string().max(REASON_MAX);
const instant = z.iso.datetime().transform((s) => new Date(s));
const gameReason = z.strictObject({ gameId: z.uuid(), reason: reasonText });

export const SYNC_CALENDAR_NOW = staffDef({
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
});

export const SAVE_LOCK = staffDef({
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
});

export const SAVE_SESSION = staffDef({
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
});

export const CANCEL_CALENDAR_EVENT = staffDef({
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
});

export const MOVE_DRIVER = staffDef({
  role: "admin",
  input: z.strictObject({
    fromEventId: z.uuid(),
    driverId: z.uuid(),
    constructorId: z.uuid().nullable(),
    carNumber: z.number().int().min(0).max(999).optional(),
    reason: reasonText,
  }),
  handler: async ({ db, now, viewer, requestId }, input) => {
    if (input.constructorId && input.carNumber === undefined) {
      throw new StaffError("invalid");
    }
    const { eventsSynced } = await changeSeats(db, now, {
      fromEventId: input.fromEventId,
      changes: [
        {
          driverId: input.driverId,
          constructorId: input.constructorId,
          carNumber: input.carNumber,
        },
      ],
      reason: input.reason,
      actor: staffActor(viewer, requestId),
    });
    return { eventsSynced };
  },
});

export const ADD_DRIVER = staffDef({
  role: "admin",
  input: z.strictObject({
    eventId: z.uuid(),
    inDriverId: z.uuid(),
    constructorId: z.uuid(),
    carNumber: z.number().int().min(0).max(999),
    outDriverId: z.uuid().nullable(),
    reason: reasonText,
  }),
  handler: async ({ db, now, viewer, requestId }, input) => {
    const { changed } = await recordSubstitution(db, now, {
      ...input,
      actor: staffActor(viewer, requestId),
    });
    return { changed };
  },
});

export const SAVE_AVAILABILITY = staffDef({
  role: "admin",
  input: z.strictObject({
    eventId: z.uuid(),
    driverId: z.uuid(),
    status: z.enum(AVAILABILITY_STATUSES),
    note: reasonText,
  }),
  handler: async ({ db, now, viewer, requestId }, input) =>
    setAvailability(db, now, staffActor(viewer, requestId), {
      ...input,
      reason: input.note,
    }),
});

export const SAVE_CORRECTION = staffDef({
  role: "admin",
  input: z.strictObject({
    sessionId: z.uuid(),
    driverId: z.uuid(),
    what: z.enum(CORRECTION_FIELDS),
    value: z.string().max(40),
    reason: reasonText,
  }),
  handler: async ({ db, now, viewer, requestId }, input) => {
    await correctResult(db, now, staffActor(viewer, requestId), input);
    return {};
  },
});

export const REVOKE_CORRECTION = staffDef({
  role: "admin",
  input: z.strictObject({ overrideId: z.uuid(), reason: reasonText }),
  handler: async ({ db, now, viewer, requestId }, input) => {
    await revokeOverride(db, now, staffActor(viewer, requestId), input);
    return {};
  },
});

export const CHECK_PROVIDER = staffDef({
  role: "admin",
  input: z.strictObject({ sessionId: z.uuid() }),
  handler: async ({ db, now }, input) => {
    const store = await webDueStore();
    return checkProviderAgain(db, now, input, store ?? undefined);
  },
});

export const START_SCORING_DRY_RUN = staffDef({
  role: "admin",
  input: gameReason,
  handler: async ({ db, now, viewer, requestId }, input) => {
    const report = await startDryRun(
      db,
      now,
      staffActor(viewer, requestId),
      input,
    );
    return { sessions: report.sessions, teamsChanged: report.teamsChanged };
  },
});

export const APPROVE_SCORING = staffDef({
  role: "admin",
  input: z.strictObject({
    gameId: z.uuid(),
    dryRunId: z.uuid(),
    reason: reasonText,
  }),
  handler: async ({ db, now, viewer, requestId }, input) =>
    approveDryRun(db, now, staffActor(viewer, requestId), input),
});

export const DISCARD_SCORING = staffDef({
  role: "admin",
  input: gameReason,
  handler: async ({ db, now, viewer, requestId }, input) =>
    discardGameDryRun(db, now, staffActor(viewer, requestId), input),
});

export const SAVE_PRICE = staffDef({
  role: "admin",
  input: z.strictObject({
    gameId: z.uuid(),
    eventId: z.uuid(),
    assetId: z.uuid(),
    price: z.string().regex(/^\d{1,3}(\.\d)?$/),
    reason: reasonText,
  }),
  handler: async ({ db, now, viewer, requestId }, input) =>
    setAdminPrice(db, now, staffActor(viewer, requestId), {
      ...input,
      price: Math.round(Number(input.price) * 10),
    }),
});

export const RESOLVE_REVIEW = staffDef({
  role: "admin",
  input: z.strictObject({
    id: z.uuid(),
    version: z.number().int().positive(),
    actionId: z.string().min(1).max(64),
    reason: reasonText,
  }),
  handler: async ({ db, now, viewer, requestId }, input) =>
    resolveReviewItem(db, now, staffActor(viewer, requestId), input),
});

export const MODERATE_ITEM = staffDef({
  role: "moderator",
  input: z.strictObject({
    id: z.uuid(),
    version: z.number().int().min(0),
    action: z.string().min(1).max(32),
    reason: reasonText,
    title: z.string().trim().min(1).max(120).optional(),
  }),
  handler: async ({ db, now, viewer, requestId }, input) => {
    // A blank reason is refused in the screen's words, before the item is read.
    const reason = staffReason(input.reason);
    const item = await modItem(db, input.id);
    if (!item) throw new StaffError("not_found");
    const chosen = item.actions.find((a) => a.action === input.action);
    if (!chosen) throw new StaffError("invalid");
    if (chosen.on === "author" && !item.author.userId) {
      throw new StaffError("invalid");
    }
    const result = await moderate(
      db,
      now,
      {
        userId: viewer.userId,
        kind: viewer.role === "admin" ? "admin" : "moderator",
        label: null,
        requestId,
      },
      {
        action: chosen.action,
        targetType:
          chosen.on === "author" ? "user" : (item.type as ModTargetType),
        targetId: chosen.on === "author" ? item.author.userId! : item.targetId,
        reason,
        ...(chosen.hours
          ? { until: new Date(now.getTime() + chosen.hours * 3_600_000) }
          : {}),
        ...(chosen.needsTitle ? { title: input.title ?? "" } : {}),
        queueItemId: item.id,
        version: input.version,
      },
    );
    if (!result.ok) throw new StaffError(result.error);
    return { changed: result.changed, label: chosen.label };
  },
});

const FORM_SETTINGS = [
  "feature_flags",
  "poll_schedule",
  "finalizer_checks",
] as const;

export const SAVE_STAFF_SETTINGS = staffDef({
  role: "admin",
  input: z.strictObject({
    reason: reasonText,
    values: z.strictObject({
      feature_flags: z.unknown().optional(),
      poll_schedule: z.unknown().optional(),
      finalizer_checks: z.unknown().optional(),
    }),
  }),
  handler: async ({ db, now, viewer, requestId }, { reason, values }) =>
    db.transaction(async (tx) => {
      const changed: string[] = [];
      // The replay clock moves with its own buttons (MOVE_REPLAY_CLOCK).
      for (const key of FORM_SETTINGS) {
        if (values[key] === undefined) continue;
        const done = await setSetting(
          tx as unknown as typeof db,
          now,
          staffActor(viewer, requestId),
          { key, value: values[key], reason },
        );
        if (done.changed) changed.push(key);
      }
      return { changed };
    }),
});

/**
 * A hosted replay's clock (M9 Task 5): pause it, start it again, or jump it
 * forward (stopping a minute before a lock). The offset is worked out from
 * real time, which only this entry point reads; the request's `now` is the
 * replay's. The due-times file is republished with the new clock, so the
 * next tick runs on it.
 */
export const MOVE_REPLAY_CLOCK = staffDef({
  role: "admin",
  input: z.discriminatedUnion("action", [
    z.strictObject({ action: z.literal("pause"), reason: reasonText }),
    z.strictObject({ action: z.literal("resume"), reason: reasonText }),
    z.strictObject({
      action: z.literal("jump"),
      to: instant,
      reason: reasonText,
    }),
  ]),
  handler: async ({ db, viewer, requestId }, input) => {
    const realNow = systemClock.now();
    const actor = staffActor(viewer, requestId);
    const result =
      input.action === "jump"
        ? await jumpReplay(db, realNow, actor, input)
        : {
            status: input.action === "pause" ? "paused" : "running",
            at: await (input.action === "pause" ? pauseReplay : resumeReplay)(
              db,
              realNow,
              actor,
              input,
            ),
          };
    const store = await webDueStore();
    if (store) {
      await publishDueTimes(
        db as TickDb,
        store,
        await hostedReplayNow(db as TickDb, realNow),
      );
    }
    return { status: result.status, at: result.at.toISOString() };
  },
});

/** Every POST in `staff.ts`, by its export name. */
export const STAFF_WRITES = {
  syncCalendarNow: SYNC_CALENDAR_NOW,
  saveLock: SAVE_LOCK,
  saveSession: SAVE_SESSION,
  cancelCalendarEvent: CANCEL_CALENDAR_EVENT,
  moveDriver: MOVE_DRIVER,
  addDriver: ADD_DRIVER,
  saveAvailability: SAVE_AVAILABILITY,
  saveCorrection: SAVE_CORRECTION,
  revokeCorrection: REVOKE_CORRECTION,
  checkProvider: CHECK_PROVIDER,
  startScoringDryRun: START_SCORING_DRY_RUN,
  approveScoring: APPROVE_SCORING,
  discardScoring: DISCARD_SCORING,
  savePrice: SAVE_PRICE,
  resolveReview: RESOLVE_REVIEW,
  moveReplayClock: MOVE_REPLAY_CLOCK,
  moderateItem: MODERATE_ITEM,
  saveStaffSettings: SAVE_STAFF_SETTINGS,
  saveUserRole: USERS.SET_ROLE,
  banAccount: USERS.BAN,
  unbanAccount: USERS.UNBAN,
  saveTrustLevel: USERS.SET_TRUST,
  releaseTrustLock: USERS.CLEAR_TRUST_LOCK,
  restrictUser: USERS.RESTRICT,
  viewAsUser: USERS.IMPERSONATE,
};
