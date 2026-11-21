/**
 * The users screen's server work (M8 Task 12), as `staffFn` definitions so
 * a test can run them through the same guard the screen does. Account
 * actions (role, ban, viewing as them) are admin-only; trust and
 * restrictions are a moderator's too, but not on other staff.
 */
import { getRequest } from "@tanstack/react-start/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { moderate } from "@/community/moderate";
import { users } from "@/db/schema";
import type { Db } from "@/db/types";
import { startImpersonation } from "@/identity/impersonation";
import { banUser, setRole, unbanUser } from "@/identity/roles";
import { clearTrustLock, setTrustLevel } from "@/identity/trust";
import { IdentityError, type Viewer } from "@/identity/viewer";
import { StaffError, type StaffErrorCode } from "@/staff/errors";
import { staffTime } from "@/staff/time";
import { findUsers, userDetail } from "@/staff/users";
import { withAuth } from "./session";
import type { StaffFnDef } from "./staff-fn";

const reason = z.string().max(2000);
const userId = z.uuid();

/** Identity's refusals in staff words; anything else stays as it is. */
const FROM_IDENTITY: Partial<Record<string, StaffErrorCode>> = {
  no_such_user: "not_found",
  role_reserved: "invalid",
  invalid_ban: "invalid",
  invalid_trust_level: "invalid",
  inactive: "invalid",
  last_admin: "last_admin",
  cannot_impersonate: "cannot_impersonate",
};

async function asStaff<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof IdentityError && FROM_IDENTITY[error.code]) {
      throw new StaffError(FROM_IDENTITY[error.code]!, error.code);
    }
    throw error;
  }
}

function staffRole(viewer: Viewer): "moderator" | "admin" {
  return viewer.role === "admin" ? "admin" : "moderator";
}

/** A moderator acts on ordinary accounts only; an admin on anyone. */
async function requireActable(db: Db, viewer: Viewer, target: string) {
  const [row] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, target));
  if (!row || row.role === "system") throw new StaffError("not_found");
  if (staffRole(viewer) === "moderator" && row.role !== "user") {
    throw new StaffError("forbidden");
  }
}

export const FIND_USERS = {
  role: "moderator",
  input: z.strictObject({ query: z.string().max(64) }),
  handler: ({ db }, { query }) => findUsers(db, query),
} satisfies StaffFnDef<{ query: string }, unknown>;

export const USER_DETAIL = {
  role: "moderator",
  input: z.strictObject({ username: z.string().min(1).max(64) }),
  handler: async ({ db, now, viewer }, { username }) => {
    const detail = await userDetail(db, now, {
      username,
      viewerRole: staffRole(viewer),
    });
    if (!detail) throw new StaffError("not_found");
    const zone = viewer.profile.timezone;
    const label = (d: Date) => staffTime(d, zone, now);
    return {
      ...detail,
      ban: detail.ban
        ? {
            reason: detail.ban.reason,
            untilLabel: detail.ban.until ? label(detail.ban.until) : null,
          }
        : null,
      restrictions: detail.restrictions.map((r) => ({
        kind: r.kind,
        reason: r.reason,
        untilLabel: r.until ? label(r.until) : null,
      })),
      recent: detail.recent.map((a) => ({
        ...a,
        atLabel: label(new Date(a.createdAt)),
        untilLabel: a.until ? label(new Date(a.until)) : null,
      })),
      trustHistory: detail.trustHistory.map(({ at, ...h }) => ({
        ...h,
        atLabel: label(at),
      })),
    };
  },
} satisfies StaffFnDef<{ username: string }, unknown>;

export const SET_ROLE = {
  role: "admin",
  input: z.strictObject({
    userId,
    role: z.enum(["user", "moderator", "admin"]),
    reason,
  }),
  handler: ({ db, now, viewer }, input) =>
    asStaff(() =>
      setRole(db, now, viewer, {
        targetUserId: input.userId,
        role: input.role,
        reason: input.reason,
      }),
    ),
} satisfies StaffFnDef<
  { userId: string; role: "user" | "moderator" | "admin"; reason: string },
  void
>;

export const BAN = {
  role: "admin",
  input: z.strictObject({
    userId,
    /** Null: until lifted. */
    days: z.number().int().min(1).max(3650).nullable(),
    reason,
  }),
  handler: ({ db, now, viewer }, input) =>
    asStaff(() =>
      banUser(db, now, viewer, {
        targetUserId: input.userId,
        until:
          input.days === null
            ? null
            : new Date(now.getTime() + input.days * 86_400_000),
        reason: input.reason,
      }),
    ),
} satisfies StaffFnDef<
  { userId: string; days: number | null; reason: string },
  void
>;

export const UNBAN = {
  role: "admin",
  input: z.strictObject({ userId, reason }),
  handler: ({ db, now, viewer }, input) =>
    asStaff(() =>
      unbanUser(db, now, viewer, {
        targetUserId: input.userId,
        reason: input.reason,
      }),
    ),
} satisfies StaffFnDef<{ userId: string; reason: string }, void>;

function trustActor(viewer: Viewer, requestId: string) {
  return {
    kind: staffRole(viewer),
    label: viewer.username ?? "staff",
    userId: viewer.userId,
    requestId,
  };
}

export const SET_TRUST = {
  role: "moderator",
  input: z.strictObject({
    userId,
    level: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
    reason,
  }),
  handler: async ({ db, now, viewer, requestId }, input) => {
    await requireActable(db, viewer, input.userId);
    await asStaff(() =>
      setTrustLevel(db, now, {
        userId: input.userId,
        level: input.level,
        reason: input.reason,
        actor: trustActor(viewer, requestId),
      }),
    );
  },
} satisfies StaffFnDef<
  { userId: string; level: 0 | 1 | 2 | 3; reason: string },
  void
>;

export const CLEAR_TRUST_LOCK = {
  role: "moderator",
  input: z.strictObject({ userId, reason }),
  handler: async ({ db, now, viewer, requestId }, input) => {
    await requireActable(db, viewer, input.userId);
    await asStaff(() =>
      clearTrustLock(db, now, {
        userId: input.userId,
        reason: input.reason,
        actor: trustActor(viewer, requestId),
      }),
    );
  },
} satisfies StaffFnDef<{ userId: string; reason: string }, void>;

export const RESTRICT = {
  role: "moderator",
  input: z.strictObject({
    userId,
    action: z.enum(["warn", "mute", "unmute", "chat_ban", "chat_unban"]),
    /** For a mute or chat ban; absent: until lifted. */
    hours: z
      .number()
      .int()
      .min(1)
      .max(24 * 365)
      .optional(),
    reason,
  }),
  handler: async ({ db, now, viewer, requestId }, input) => {
    await requireActable(db, viewer, input.userId);
    const timed = input.action === "mute" || input.action === "chat_ban";
    const result = await moderate(
      db,
      now,
      {
        userId: viewer.userId,
        kind: staffRole(viewer),
        label: null,
        requestId,
      },
      {
        action: input.action,
        targetType: "user",
        targetId: input.userId,
        reason: input.reason,
        ...(timed && input.hours
          ? { until: new Date(now.getTime() + input.hours * 3_600_000) }
          : {}),
      },
    );
    if (!result.ok) throw new StaffError(result.error);
    return { changed: result.changed };
  },
} satisfies StaffFnDef<
  {
    userId: string;
    action: "warn" | "mute" | "unmute" | "chat_ban" | "chat_unban";
    hours?: number;
    reason: string;
  },
  { changed: boolean }
>;

/**
 * Starts viewing the site as the user (DM 6.4), through the existing flow:
 * `startImpersonation` and all its checks, on this request's session, whose
 * cookies Better Auth sets on this response. The screen then goes home.
 */
export const IMPERSONATE = {
  role: "admin",
  input: z.strictObject({ userId, reason }),
  handler: async ({ viewer }, input) => {
    const headers = getRequest().headers;
    await asStaff(() =>
      withAuth((auth, db, now) =>
        startImpersonation(auth, db, now, {
          viewer,
          targetUserId: input.userId,
          reason: input.reason,
          headers,
        }),
      ),
    );
  },
} satisfies StaffFnDef<{ userId: string; reason: string }, void>;
