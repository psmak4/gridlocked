/**
 * Reads the signed-in person for a request. The one place the site turns a
 * cookie into a `Viewer`.
 */
import { and, eq } from "drizzle-orm";
import { getSessionCookie } from "better-auth/cookies";
import { authSessions, profiles, users } from "@/db/schema";
import { createAuth, ensureProfile, type Auth } from "@/identity/auth";
import { parseAuthEnv, type AuthEnv } from "@/identity/env";
import { touchViewer, type Viewer } from "@/identity/viewer";
import { clockModeFromEnv, resolveClock } from "@/lib/resolve-clock";
import { withDb, type ServerDb } from "./db";

export type SessionDeps = {
  withDb: <T>(fn: (db: ServerDb) => Promise<T>) => Promise<T>;
  env: () => AuthEnv;
  /** The request's "now", resolved once (HLD decision 20). */
  now: (db: ServerDb) => Promise<Date>;
};

let parsedEnv: AuthEnv | undefined;

/** Parsed on first use, so the build and logged-out pages need no secrets. */
function authEnv(): AuthEnv {
  parsedEnv ??= parseAuthEnv({
    ...process.env,
    // Replaced at build time; `process.env` has no such variable in a build.
    VITE_LOCAL_DB: import.meta.env.VITE_LOCAL_DB,
  });
  return parsedEnv;
}

const defaultDeps: SessionDeps = {
  withDb,
  env: authEnv,
  now: async (db) =>
    (
      await resolveClock({
        mode: clockModeFromEnv(process.env),
        db,
      })
    ).now(),
};

/** Runs `fn` with an auth instance on this request's database. */
export function withAuth<T>(
  fn: (auth: Auth) => Promise<T>,
  deps: SessionDeps = defaultDeps,
): Promise<T> {
  return deps.withDb(async (db) => {
    const now = await deps.now(db);
    return fn(createAuth(db, { env: deps.env(), now: () => now }));
  });
}

/**
 * The viewer for a request, or null. With no session cookie it returns before
 * touching the database. Otherwise: read the session, make sure the profile
 * exists, then record the visit.
 */
export async function getViewer(
  request: Request,
  deps: SessionDeps = defaultDeps,
): Promise<Viewer | null> {
  if (!getSessionCookie(request)) return null;
  return deps.withDb(async (db) => {
    const now = await deps.now(db);
    const auth = createAuth(db, { env: deps.env(), now: () => now });
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return null;

    await ensureProfile(db, now, session.user.id);
    const [row] = await db
      .select({
        user: users,
        profile: profiles,
        impersonatedBy: authSessions.impersonatedBy,
        staffVerifiedAt: authSessions.staffVerifiedAt,
      })
      .from(authSessions)
      .innerJoin(users, eq(users.id, authSessions.userId))
      .innerJoin(profiles, eq(profiles.userId, users.id))
      .where(
        and(
          eq(authSessions.id, session.session.id),
          eq(authSessions.userId, session.user.id),
        ),
      );
    if (!row) return null;

    const { user, profile } = row;
    const viewer: Viewer = {
      userId: user.id,
      role: user.role,
      username: user.username,
      displayUsername: user.displayUsername,
      emailVerified: user.emailVerified,
      twoFactorEnabled: user.twoFactorEnabled,
      sessionId: session.session.id,
      impersonatedBy: row.impersonatedBy,
      staffVerifiedAt: row.staffVerifiedAt,
      profile,
      complete: user.username !== null && profile.ageConfirmedAt !== null,
    };
    return touchViewer(db, now, viewer);
  });
}
