/**
 * Impersonation (DM 6.4): an admin sees the site as a user, for support.
 * Admins only, from a session that passed the staff two-step; one hour at
 * most; every start and stop audited with both user ids; and read-only, which
 * `hooks.before` in auth.ts and `requireWritable` enforce. The admin plugin
 * mints and ends the session, reached only from here through `auth.api`:
 * both of its routes are closed over HTTP, where the checks would be skipped.
 */
import { eq } from "drizzle-orm";
import { writeAudit } from "@/audit/log";
import { authSessions, users } from "@/db/schema";
import type { Db } from "@/db/types";
import { requireReason } from "@/staff/roster";
import { auditImpersonationStop, type Auth } from "./auth";
import { requireStaff } from "./staff-access";
import { IdentityError, requireViewer, type Viewer } from "./viewer";

/**
 * Starts impersonating `targetUserId`. `headers` are the admin's request
 * headers (their session cookie); the returned headers set the impersonation
 * cookie and keep the admin's own session aside for `stopImpersonating`.
 * Nobody impersonates an admin, the system user or themselves.
 */
export async function startImpersonation(
  auth: Auth,
  db: Db,
  now: Date,
  input: {
    viewer: Viewer | null;
    targetUserId: string;
    reason: string;
    headers: Headers;
  },
): Promise<{ headers: Headers }> {
  const admin = requireStaff(input.viewer, "admin");
  const reason = requireReason(input.reason);
  // The plugin acts on the session in `headers`; the checks above were on
  // `viewer`. They must be the same session (ruling 39).
  const carried = await auth.api.getSession({ headers: input.headers });
  if (carried?.session.id !== admin.sessionId) {
    throw new IdentityError("unauthenticated");
  }
  const [target] = await db
    .select({
      id: users.id,
      role: users.role,
      banned: users.banned,
      banExpires: users.banExpires,
    })
    .from(users)
    .where(eq(users.id, input.targetUserId));
  if (!target) throw new IdentityError("no_such_user");
  const banned =
    target.banned &&
    (target.banExpires === null || target.banExpires.getTime() > now.getTime());
  if (
    target.id === admin.userId ||
    target.role === "admin" ||
    target.role === "system" ||
    // The plugin would refuse a banned user's session with its own error.
    banned
  ) {
    throw new IdentityError("cannot_impersonate");
  }

  const { headers, response } = await auth.api.impersonateUser({
    body: { userId: target.id },
    headers: input.headers,
    returnHeaders: true,
  });
  const session = response.session as { id: string; expiresAt: Date };
  try {
    await writeAudit(db, now, {
      actorUserId: admin.userId,
      impersonatingUserId: target.id,
      actorKind: "admin",
      actorLabel: null,
      action: "user.impersonate.start",
      entityType: "user",
      entityId: target.id,
      before: null,
      after: {
        sessionId: session.id,
        expiresAt: new Date(session.expiresAt).toISOString(),
      },
      reason,
      requestId: null,
    });
  } catch (error) {
    // No impersonation without its record: end the session that was made.
    await db.delete(authSessions).where(eq(authSessions.id, session.id));
    throw error;
  }
  return { headers };
}

/**
 * Ends the viewer's impersonation and puts the admin's own session back
 * (the returned headers set its cookie), audited as `user.impersonate.stop`.
 * A failed audit is logged and doesn't keep the admin out of their session.
 * Signing out ends it too; auth.ts audits that one.
 */
export async function stopImpersonating(
  auth: Auth,
  db: Db,
  now: Date,
  input: { viewer: Viewer | null; headers: Headers },
): Promise<{ headers: Headers }> {
  const v = requireViewer(input.viewer);
  if (v.impersonatedBy === null) throw new IdentityError("not_impersonating");
  const { headers } = await auth.api.stopImpersonating({
    headers: input.headers,
    returnHeaders: true,
  });
  // The impersonation has already ended, so the admin gets their session
  // back even if the record can't be written; the failure is logged by name,
  // with no ids or addresses.
  try {
    await auditImpersonationStop(db, now, {
      adminUserId: v.impersonatedBy,
      targetUserId: v.userId,
      sessionId: v.sessionId,
      via: "stop",
    });
  } catch (error) {
    console.error(
      `impersonation stop audit failed: ${error instanceof Error ? error.name : "unknown"}`,
    );
  }
  return { headers };
}
