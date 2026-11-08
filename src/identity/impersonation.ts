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
  const [target] = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.id, input.targetUserId));
  if (!target) throw new IdentityError("no_such_user");
  if (
    target.id === admin.userId ||
    target.role === "admin" ||
    target.role === "system"
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
  await auditImpersonationStop(db, now, {
    adminUserId: v.impersonatedBy,
    targetUserId: v.userId,
    sessionId: v.sessionId,
    via: "stop",
  });
  return { headers };
}
