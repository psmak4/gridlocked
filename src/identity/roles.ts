/**
 * Roles and bans (DM 6.4). `users.role` is the single source of truth. Each
 * change is one transaction with its audit row (DM 6.6), and revokes the
 * target's sessions, so the change holds from the next request.
 *
 * Nothing here imports Better Auth. The permissions below are plain data;
 * `auth.ts` turns them into the admin plugin's access-control config.
 */
import { and, asc, eq, lte, ne, or } from "drizzle-orm";
import { writeAudit } from "@/audit/log";
import {
  authSessions,
  profiles,
  users,
  USER_ROLES,
  type UserRole,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { audit, requireReason, type StaffActor } from "@/staff/roster";
import { IdentityError } from "./viewer";

export type Role = UserRole;
export { USER_ROLES as ROLES };

/** The roles staff tools check for, lowest first. */
export const STAFF_ROLES = ["moderator", "admin"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/** True if `role` is at least `needed`. `system` and `user` are never staff. */
export function hasStaffRole(role: Role, needed: StaffRole): boolean {
  const rank = (r: Role) => STAFF_ROLES.indexOf(r as StaffRole);
  return rank(role) >= 0 && rank(role) >= rank(needed);
}

/**
 * What each role may do through the admin plugin's endpoints, in the
 * plugin's own statement names. Reviewed in code, never stored (DM 6.4).
 * Only impersonation is reachable today, and only through
 * `startImpersonation`; the rest of the plugin's routes are closed.
 * Nobody has `impersonate-admins`, so no admin can become another.
 */
export const ROLE_PERMISSIONS = {
  user: { user: [], session: [] },
  moderator: {
    user: ["list", "get", "ban"],
    session: ["list", "revoke"],
  },
  admin: {
    user: [
      "create",
      "list",
      "set-role",
      "ban",
      "impersonate",
      "delete",
      "set-password",
      "set-email",
      "set-phone",
      "get",
      "update",
    ],
    session: ["list", "revoke", "delete"],
  },
} as const satisfies Record<
  Exclude<Role, "system">,
  { user: readonly string[]; session: readonly string[] }
>;

type Tx = Db;

/**
 * The target, locked for this transaction. `system` can't be changed. FOR NO
 * KEY UPDATE (Ruling 58): the row isn't deleted or re-keyed here, so an
 * insert elsewhere that points at it (KEY SHARE) needn't wait for it.
 */
async function lockTarget(tx: Tx, userId: string) {
  const [target] = await tx
    .select({
      id: users.id,
      role: users.role,
      banned: users.banned,
      banExpires: users.banExpires,
    })
    .from(users)
    .where(eq(users.id, userId))
    .for("no key update");
  if (!target) throw new IdentityError("no_such_user");
  if (target.role === "system") throw new IdentityError("role_reserved");
  return target;
}

/**
 * Locks every admin row, in id order, before anything else (ruling 39). Two
 * changes then take their locks in the same order, so two admins demoting
 * each other wait for one another instead of deadlocking, and the second
 * sees the first's result (`last_admin`). FOR NO KEY UPDATE still queues
 * two of these; the scrub that re-keys a row locks it FOR UPDATE itself.
 */
export async function lockAdmins(tx: Tx): Promise<void> {
  await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.role, "admin"))
    .orderBy(asc(users.id))
    .for("no key update");
}

/** Postgres's deadlock code, on the error or the one drizzle wraps. */
function isDeadlock(error: unknown): boolean {
  const codeOf = (e: unknown) =>
    typeof e === "object" && e !== null && "code" in e
      ? (e as { code: unknown }).code
      : undefined;
  return (
    codeOf(error) === "40P01" ||
    codeOf((error as { cause?: unknown } | null)?.cause) === "40P01"
  );
}

const DEADLOCK_ATTEMPTS = 3;

/**
 * Runs a staff change's transaction, again if Postgres broke a deadlock by
 * aborting it (the ordered locks make that rare), and as `try_again` if it
 * keeps happening, never as a raw database error.
 */
export async function staffTransaction<T = void>(
  db: Db,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.transaction((transaction) =>
        fn(transaction as unknown as Db),
      );
    } catch (error) {
      if (!isDeadlock(error)) throw error;
      if (attempt >= DEADLOCK_ATTEMPTS) throw new IdentityError("try_again");
    }
  }
}

/**
 * Refuses if no admin other than `exceptUserId` would be left active: not
 * banned (or banned with an end that has passed) and not deleted. Call it
 * after `lockAdmins`.
 */
export async function requireAnotherAdmin(
  tx: Tx,
  now: Date,
  exceptUserId: string,
): Promise<void> {
  const [other] = await tx
    .select({ id: users.id })
    .from(users)
    .innerJoin(profiles, eq(profiles.userId, users.id))
    .where(
      and(
        eq(users.role, "admin"),
        ne(users.id, exceptUserId),
        eq(profiles.status, "active"),
        // An expired ban is no ban.
        or(eq(users.banned, false), lte(users.banExpires, now)),
      ),
    )
    .limit(1);
  if (!other) throw new IdentityError("last_admin");
}

/** Every session the user holds, and every one they hold as someone else. */
async function revokeSessions(tx: Tx, userId: string): Promise<void> {
  await tx
    .delete(authSessions)
    .where(
      or(
        eq(authSessions.userId, userId),
        eq(authSessions.impersonatedBy, userId),
      ),
    );
}

/**
 * Gives `targetUserId` the role `role`, with the audit `user.role.update`.
 * Refuses `system` (as the role or the target) and leaving no active admin.
 * The same role again changes nothing and writes nothing.
 */
export async function setRole(
  db: Db,
  now: Date,
  input: {
    targetUserId: string;
    role: Role;
    reason: string;
    actor: StaffActor;
  },
): Promise<void> {
  const reason = requireReason(input.reason);
  if (input.role === "system" || !USER_ROLES.includes(input.role)) {
    throw new IdentityError("role_reserved");
  }
  await staffTransaction(db, async (tx) => {
    await lockAdmins(tx);
    const target = await lockTarget(tx, input.targetUserId);
    if (target.role === input.role) return;
    if (target.role === "admin") {
      await requireAnotherAdmin(tx, now, target.id);
    }
    await tx
      .update(users)
      .set({ role: input.role, updatedAt: now })
      .where(eq(users.id, target.id));
    await revokeSessions(tx, target.id);
    await writeAudit(tx, now, {
      ...audit(input.actor, reason),
      action: "user.role.update",
      entityType: "user",
      entityId: target.id,
      before: { role: target.role },
      after: { role: input.role },
    });
  });
}

/**
 * Bans `targetUserId` until `until` (null: until lifted), revokes their
 * sessions and writes the audit `user.ban`. Better Auth refuses a banned
 * user's next sign-in and lifts a ban whose end has passed. M7 adds the
 * `mod_actions` mirror (DM 5.9).
 */
export async function banUser(
  db: Db,
  now: Date,
  input: {
    targetUserId: string;
    until: Date | null;
    reason: string;
    actor: StaffActor;
  },
): Promise<void> {
  const reason = requireReason(input.reason);
  if (input.until !== null && input.until.getTime() <= now.getTime()) {
    throw new IdentityError("invalid_ban");
  }
  await staffTransaction(db, async (tx) => {
    await lockAdmins(tx);
    const target = await lockTarget(tx, input.targetUserId);
    if (target.role === "admin") {
      await requireAnotherAdmin(tx, now, target.id);
    }
    await tx
      .update(users)
      .set({
        banned: true,
        banReason: reason,
        banExpires: input.until,
        updatedAt: now,
      })
      .where(eq(users.id, target.id));
    await revokeSessions(tx, target.id);
    await writeAudit(tx, now, {
      ...audit(input.actor, reason),
      action: "user.ban",
      entityType: "user",
      entityId: target.id,
      before: {
        banned: target.banned,
        banExpires: target.banExpires?.toISOString() ?? null,
      },
      after: {
        banned: true,
        banExpires: input.until?.toISOString() ?? null,
      },
    });
  });
}

/** Lifts a ban at once, with the audit `user.unban`. */
export async function unbanUser(
  db: Db,
  now: Date,
  input: { targetUserId: string; reason: string; actor: StaffActor },
): Promise<void> {
  const reason = requireReason(input.reason);
  await staffTransaction(db, async (tx) => {
    const target = await lockTarget(tx, input.targetUserId);
    if (!target.banned) return;
    await tx
      .update(users)
      .set({ banned: false, banReason: null, banExpires: null, updatedAt: now })
      .where(eq(users.id, target.id));
    await writeAudit(tx, now, {
      ...audit(input.actor, reason),
      action: "user.unban",
      entityType: "user",
      entityId: target.id,
      before: {
        banned: true,
        banExpires: target.banExpires?.toISOString() ?? null,
      },
      after: { banned: false },
    });
  });
}
