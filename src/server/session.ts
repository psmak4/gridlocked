/**
 * Reads the signed-in person for a request. The one place the site turns a
 * cookie into a `Viewer`.
 */
import { and, eq } from "drizzle-orm";
import { getSessionCookie } from "better-auth/cookies";
import { authSessions, profiles, users } from "@/db/schema";
import {
  createAuth,
  ensureProfile,
  IMPERSONATION_SECONDS,
  type Auth,
} from "@/identity/auth";
import { createResendSender } from "@/identity/email/resend";
import type { EmailSender } from "@/identity/email/sender";
import { pendingDocuments } from "@/identity/consent";
import { parseAuthEnv, type AuthEnv } from "@/identity/env";
import { touchViewer, type Viewer } from "@/identity/viewer";
import { clockModeFromEnv, resolveClock } from "@/lib/resolve-clock";
import { withDb, type ServerDb } from "./db";

export type SessionDeps = {
  withDb: <T>(fn: (db: ServerDb) => Promise<T>) => Promise<T>;
  env: () => AuthEnv;
  /** The request's "now", resolved once (HLD decision 20). */
  now: (db: ServerDb) => Promise<Date>;
  /** Where account emails go; unset means none (they queue). */
  sender?: () => Promise<EmailSender | null>;
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

/**
 * The email sender for this host. Local builds capture mail in memory for the
 * e2e tests (the flag is replaced at build time, so a normal build drops that
 * code); a deployed host sends through Resend once both variables are set,
 * and until then emails stay queued.
 */
async function defaultSender(): Promise<EmailSender | null> {
  if (import.meta.env.VITE_LOCAL_DB === "1") {
    return import("./local-db").then((m) => m.memorySender);
  }
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  return apiKey && from ? createResendSender({ apiKey, from, fetch }) : null;
}

const defaultDeps: SessionDeps = {
  withDb,
  env: authEnv,
  sender: defaultSender,
  now: async (db) =>
    (
      await resolveClock({
        mode: clockModeFromEnv(process.env),
        db,
      })
    ).now(),
};

/**
 * Runs `fn` with the request's database and its "now" (HLD decision 20), for
 * the server functions that read or write outside Better Auth.
 */
export function withRequestNow<T>(
  fn: (db: ServerDb, now: Date) => Promise<T>,
  deps: SessionDeps = defaultDeps,
): Promise<T> {
  return deps.withDb(async (db) => fn(db, await deps.now(db)));
}

/** Runs `fn` with an auth instance on this request's database. */
export function withAuth<T>(
  fn: (auth: Auth) => Promise<T>,
  deps: SessionDeps = defaultDeps,
): Promise<T> {
  return deps.withDb(async (db) => {
    const now = await deps.now(db);
    const sender = (await deps.sender?.()) ?? null;
    return fn(createAuth(db, { env: deps.env(), now: () => now, sender }));
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
    const auth = createAuth(db, {
      env: deps.env(),
      now: () => now,
      sender: null,
    });
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session) return null;

    await ensureProfile(db, now, session.user.id);
    const [row] = await db
      .select({
        user: users,
        profile: profiles,
        impersonatedBy: authSessions.impersonatedBy,
        staffVerifiedAt: authSessions.staffVerifiedAt,
        sessionCreatedAt: authSessions.createdAt,
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
    // Ruling 38: an impersonation older than its hour is over, by our clock,
    // whatever the row's expiry says.
    if (
      row.impersonatedBy !== null &&
      now.getTime() - row.sessionCreatedAt.getTime() >=
        IMPERSONATION_SECONDS * 1000
    ) {
      return null;
    }

    const { user, profile } = row;
    const viewer: Viewer = {
      userId: user.id,
      role: user.role,
      banned:
        user.banned &&
        (user.banExpires === null || user.banExpires.getTime() > now.getTime()),
      username: user.username,
      displayUsername: user.displayUsername,
      emailVerified: user.emailVerified,
      twoFactorEnabled: user.twoFactorEnabled,
      sessionId: session.session.id,
      impersonatedBy: row.impersonatedBy,
      staffVerifiedAt: row.staffVerifiedAt,
      profile,
      complete:
        user.username !== null &&
        profile.ageConfirmedAt !== null &&
        (await pendingDocuments(db, user.id)).length === 0,
    };
    return touchViewer(db, now, viewer);
  });
}
