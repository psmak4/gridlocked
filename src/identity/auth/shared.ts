/**
 * The constants and helpers `createAuth` and its hooks share (split out of
 * `auth.ts` in M7).
 */
import { admin, username } from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/admin/access";
import { and, eq, inArray, ne } from "drizzle-orm";
import { authAccounts, authSessions, profiles } from "@/db/schema";
import { writeAudit } from "@/audit/log";
import { ROLE_PERMISSIONS } from "../roles";
import type { Db } from "@/db/types";
import type { AuthEnv } from "../env";

/**
 * Anyone with a confirmed address can sign in by an emailed link: the
 * `magicLink` plugin below is always on. Settings counts that address as a
 * way in when it decides whether a method is the last (Ruling 58).
 */
export const MAGIC_LINK_SIGN_IN = true;

/** A magic link works once and for this long (the outbox row expires with it). */
export const MAGIC_LINK_SECONDS = 900;
/** Verification and reset links; Better Auth's own default, and under the outbox's 24 h. */
export const EMAIL_LINK_SECONDS = 3600;

/**
 * Paths Turnstile guards. The plugin's own default list leaves out magic
 * links, verification and email change, so the list is spelled out.
 */
export const CAPTCHA_PATHS = [
  "/sign-up/email",
  "/sign-in/email",
  "/sign-in/magic-link",
  "/request-password-reset",
  "/send-verification-email",
  "/change-email",
];

/** Where an email address sits in the body, for the paths that send one a link. */
export const ADDRESS_FIELD: Record<string, string> = {
  "/sign-in/magic-link": "email",
  "/request-password-reset": "email",
  "/send-verification-email": "email",
  "/change-email": "newEmail",
};

/** Where "Secure your account" in the notice to an old address leads. */
export const SECURE_ACCOUNT_PATH = "/forgot-password";

/**
 * Staff actions that need an audit row in the same transaction are ours (DM
 * 6.6), so no admin endpoint is reachable over HTTP. Impersonation still uses
 * the plugin's two endpoints, but only through `auth.api`, from
 * `startImpersonation` and `stopImpersonating`, which check the staff
 * two-step and write the audit (DM 6.4). Over HTTP an admin could skip both.
 * The list is read from the plugin, so an endpoint a later release adds is
 * closed too.
 */
export const DISABLED_AUTH_PATHS = [
  ...Object.values(admin().endpoints).map((endpoint) => endpoint.path),
  // `deleteUser.enabled: false` makes these refuse, but they would still be
  // routed; Better Auth's deletion is a hard delete (DM 6.0).
  "/delete-user",
  "/delete-user/callback",
  // Sign-in is by email, magic link or Discord, never by username, and
  // availability is `checkUsername`'s to answer, not an open endpoint.
  // Read from the plugin, like the admin list.
  ...Object.values(username().endpoints).map((endpoint) => endpoint.path),
  // Settings removes a sign-in method itself (`removeSignInMethodAction`):
  // under a row lock, so two removals can't leave none, and audited.
  "/unlink-account",
  // Nothing of ours calls these (Ruling 58). A password check a session can
  // call 100 times in 10 s is an oracle; provider tokens and the live Discord
  // profile have no business in the browser (and /account-info can refresh a
  // token on a GET, a write an impersonated session would get past); and
  // session fields are set by our own code.
  "/verify-password",
  "/account-info",
  "/get-access-token",
  "/refresh-token",
  "/update-session",
];

/** The TOTP step, in seconds; `verifyStaffSession` checks codes with it. */
export const TOTP_PERIOD_SECONDS = 30;

/** An impersonation lasts this long (DM 6.4). */
export const IMPERSONATION_SECONDS = 3600;

/**
 * The only writes an impersonated session may make: ending it (DM 6.4).
 * Everything else that isn't a read is refused in `hooks.before`.
 */
export const IMPERSONATION_EXITS = ["/sign-out", "/admin/stop-impersonating"];

/** The refusal code, also what the read-only banner keys on. */
export const IMPERSONATION_READ_ONLY = "IMPERSONATION_READ_ONLY";

/** A staff member managing their factor from a session not yet unlocked. */
export const STAFF_SESSION_UNVERIFIED = "STAFF_SESSION_UNVERIFIED";

/**
 * The session token in a request's cookie, read without checking the
 * signature. Only ever a lookup key: it matches a row only if it's real.
 */
export function sessionTokenIn(
  headers: Headers | undefined,
  cookieName: string,
): string | null {
  const header = headers?.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name !== cookieName) continue;
    let value: string;
    try {
      value = decodeURIComponent(rest.join("="));
    } catch {
      return null;
    }
    const dot = value.lastIndexOf(".");
    return dot > 0 ? value.slice(0, dot) : null;
  }
  return null;
}

/**
 * The admin plugin's access control (DM 6.4): its own statement names, with
 * each role's permissions from `ROLE_PERMISSIONS` in roles.ts.
 */
export const accessControl = createAccessControl(defaultStatements);
const role = (
  permissions: (typeof ROLE_PERMISSIONS)[keyof typeof ROLE_PERMISSIONS],
) =>
  accessControl.newRole({
    user: [...permissions.user],
    session: [...permissions.session],
  });
export const ACCESS_ROLES = {
  user: role(ROLE_PERMISSIONS.user),
  moderator: role(ROLE_PERMISSIONS.moderator),
  admin: role(ROLE_PERMISSIONS.admin),
};

/** Why a sign-up is refused. No address in it: errors reach logs. */
export const SIGN_UP_CLOSED = "Sign-up isn't open for this address.";

/** `SIGN_UP_ALLOWED_EMAILS`, when set, names every address an account may have. */
export function allowedToSignUp(env: AuthEnv, address: string): boolean {
  const allowlist = env.signUpAllowlist;
  return allowlist === null || allowlist.includes(address.trim().toLowerCase());
}

/**
 * The /update-user body fields our pages post: none. Better Auth itself
 * needs none either (its client sends only what the caller passes).
 */
export const UPDATE_USER_FIELDS: ReadonlySet<string> = new Set<string>();

/**
 * Makes the user's `profiles` row if it is missing; safe to call again. The
 * sign-up hook calls it, and so does every session read, so a hook that was
 * lost (a crash between the two writes) repairs itself.
 */
export async function ensureProfile(
  db: Db,
  now: Date,
  userId: string,
): Promise<void> {
  await db
    .insert(profiles)
    .values({
      userId,
      status: "active",
      avatarSeed: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
}

/**
 * Better Auth's loggers print the error object, and a database error's
 * message carries the query's parameters: an email address. This one writes
 * the level and the error's name, and drops every message and argument.
 */
export function logAuthEvent(
  level: string,
  _message: string,
  ...args: unknown[]
): void {
  const failure = args.find((arg) => arg instanceof Error);
  const line = `better-auth ${level}: ${failure?.name ?? "event"}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/** One `audit_log` row for something a user did to their own sign-in details. */
export function auditUserChange(
  db: Db,
  now: Date,
  action: "user.email.update" | "user.password.update",
  userId: string,
  change: {
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  } = { before: null, after: null },
): Promise<string> {
  return writeAudit(db, now, {
    actorUserId: userId,
    actorKind: "user",
    actorLabel: null,
    action,
    entityType: "user",
    entityId: userId,
    ...change,
    reason: null,
    requestId: null,
  });
}

/**
 * Better Auth's magic link strips every link and session an unverified account
 * gathered before its address was proved (revokeUnprovenAccountAccess); a
 * verification link or a reset does not. Without this, someone who signed in
 * with Discord on an address they don't own (Discord allows an unverified
 * email) keeps that way in after the owner proves the address. Credentials
 * stay: a reset or sign-up password is the owner's to choose. Call it while
 * the account is still unverified.
 */
export async function revokeUnprovenSignIns(
  db: Db,
  now: Date,
  userId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const linked = await t
      .select({ id: authAccounts.id, providerId: authAccounts.providerId })
      .from(authAccounts)
      .where(
        and(
          eq(authAccounts.userId, userId),
          ne(authAccounts.providerId, "credential"),
        ),
      );
    // Every session goes, links or not: nothing that predates the proof is
    // known to be the owner's. The sign-in the proof makes comes after.
    await t.delete(authSessions).where(eq(authSessions.userId, userId));
    if (linked.length === 0) return;
    await t.delete(authAccounts).where(
      inArray(
        authAccounts.id,
        linked.map((a) => a.id),
      ),
    );
    await writeAudit(t, now, {
      actorUserId: null,
      actorKind: "system",
      actorLabel: "email proof",
      action: "user.accounts.revoke_unproven",
      entityType: "user",
      entityId: userId,
      before: null,
      after: {
        count: linked.length,
        providers: linked.map((a) => a.providerId),
      },
      reason: null,
      requestId: null,
    });
  });
}

/**
 * The claims of a verification token, read without checking the signature. Only
 * ever a lookup key: nothing is recorded because a claim says so.
 */
export function tokenClaims(
  token: unknown,
): { email?: string; updateTo?: string; requestType?: string } | null {
  if (typeof token !== "string") return null;
  try {
    const payload = token.split(".")[1];
    if (!payload) return null;
    const claims: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    return typeof claims === "object" && claims !== null ? claims : null;
  } catch {
    return null;
  }
}

/** The audit row for an impersonation that ended (DM 6.4, 6.6). */
export function auditImpersonationStop(
  db: Db,
  now: Date,
  input: {
    adminUserId: string;
    targetUserId: string;
    sessionId: string;
    via: "stop" | "sign-out";
  },
): Promise<string> {
  return writeAudit(db, now, {
    actorUserId: input.adminUserId,
    impersonatingUserId: input.targetUserId,
    actorKind: "admin",
    actorLabel: null,
    action: "user.impersonate.stop",
    entityType: "user",
    entityId: input.targetUserId,
    before: null,
    after: { sessionId: input.sessionId, via: input.via },
    reason: null,
    requestId: null,
  });
}

/** Better Auth stores imported secrets base32 behind this prefix. */
