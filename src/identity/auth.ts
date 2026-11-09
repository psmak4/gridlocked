/**
 * Better Auth (HLD decisions 4-5, DM 6.0) on our own tables. This file and
 * `auth-client.ts` and `src/server/` are the only places that import it
 * (ESLint enforces that).
 *
 * Better Auth reads its own clock for the rows it writes; everything of ours
 * takes `now` from the caller.
 */
import { queueAfterTransactionHook } from "@better-auth/core/context";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
} from "better-auth/api";
import { symmetricDecrypt, symmetricEncrypt } from "better-auth/crypto";
import {
  admin,
  captcha,
  magicLink,
  twoFactor,
  username,
} from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/admin/access";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { and, eq, inArray, ne } from "drizzle-orm";
import * as schema from "@/db/schema";
import {
  authAccounts,
  authSessions,
  authTwoFactors,
  profiles,
  users,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { writeAudit } from "@/audit/log";
import { newId } from "@/lib/ids";
import type { AuthEnv } from "./env";
import { queueEmail } from "./email/outbox";
import type { EmailSender } from "./email/sender";
import type { EmailTemplate } from "./email/templates";
import { completeSignUp } from "./consent";
import { hasStaffRole, ROLE_PERMISSIONS } from "./roles";
import {
  checkUsername,
  isValidUsernameFormat,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
} from "./usernames";

export type AuthDeps = {
  env: AuthEnv;
  now: () => Date;
  /** Where account emails go; null queues them until a provider is set up. */
  sender: EmailSender | null;
};

/**
 * Anyone with a confirmed address can sign in by an emailed link: the
 * `magicLink` plugin below is always on. Settings counts that address as a
 * way in when it decides whether a method is the last (Ruling 58).
 */
export const MAGIC_LINK_SIGN_IN = true;

/** A magic link works once and for this long (the outbox row expires with it). */
const MAGIC_LINK_SECONDS = 900;
/** Verification and reset links; Better Auth's own default, and under the outbox's 24 h. */
const EMAIL_LINK_SECONDS = 3600;

/**
 * Paths Turnstile guards. The plugin's own default list leaves out magic
 * links, verification and email change, so the list is spelled out.
 */
const CAPTCHA_PATHS = [
  "/sign-up/email",
  "/sign-in/email",
  "/sign-in/magic-link",
  "/request-password-reset",
  "/send-verification-email",
  "/change-email",
];

/** Where an email address sits in the body, for the paths that send one a link. */
const ADDRESS_FIELD: Record<string, string> = {
  "/sign-in/magic-link": "email",
  "/request-password-reset": "email",
  "/send-verification-email": "email",
  "/change-email": "newEmail",
};

/** Where "Secure your account" in the notice to an old address leads. */
const SECURE_ACCOUNT_PATH = "/forgot-password";

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
const IMPERSONATION_EXITS = ["/sign-out", "/admin/stop-impersonating"];

/** The refusal code, also what the read-only banner keys on. */
export const IMPERSONATION_READ_ONLY = "IMPERSONATION_READ_ONLY";

/** A staff member managing their factor from a session not yet unlocked. */
export const STAFF_SESSION_UNVERIFIED = "STAFF_SESSION_UNVERIFIED";

/**
 * The session token in a request's cookie, read without checking the
 * signature. Only ever a lookup key: it matches a row only if it's real.
 */
function sessionTokenIn(
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
const accessControl = createAccessControl(defaultStatements);
const role = (
  permissions: (typeof ROLE_PERMISSIONS)[keyof typeof ROLE_PERMISSIONS],
) =>
  accessControl.newRole({
    user: [...permissions.user],
    session: [...permissions.session],
  });
const ACCESS_ROLES = {
  user: role(ROLE_PERMISSIONS.user),
  moderator: role(ROLE_PERMISSIONS.moderator),
  admin: role(ROLE_PERMISSIONS.admin),
};

/** Why a sign-up is refused. No address in it: errors reach logs. */
const SIGN_UP_CLOSED = "Sign-up isn't open for this address.";

/** `SIGN_UP_ALLOWED_EMAILS`, when set, names every address an account may have. */
function allowedToSignUp(env: AuthEnv, address: string): boolean {
  const allowlist = env.signUpAllowlist;
  return allowlist === null || allowlist.includes(address.trim().toLowerCase());
}

/**
 * The /update-user body fields our pages post: none. Better Auth itself
 * needs none either (its client sends only what the caller passes).
 */
const UPDATE_USER_FIELDS: ReadonlySet<string> = new Set<string>();

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
function auditUserChange(
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
async function revokeUnprovenSignIns(
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
function tokenClaims(
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

export function createAuth(db: Db, deps: AuthDeps) {
  const { env, now, sender } = deps;
  // Sign-up calls its email callback inside its transaction. The outbox
  // needs its own, so the mail waits for the commit (on one connection, as in
  // tests and local runs, it would wait for ever otherwise). A failure is
  // logged by name only and doesn't fail the request: the reply must not
  // depend on the address.
  const mail = (
    to: string,
    template: EmailTemplate,
    url: string,
    lifetimeSeconds?: number,
  ) =>
    queueAfterTransactionHook(
      async () => {
        await queueEmail(
          db,
          now(),
          {
            to,
            template,
            payload: { url },
            ...(lifetimeSeconds !== undefined && {
              expiresAt: new Date(now().getTime() + lifetimeSeconds * 1000),
            }),
          },
          sender,
        );
      },
      {
        onError: (error) => {
          console.error(
            `better-auth email failed: ${error instanceof Error ? error.name : "unknown"}`,
          );
        },
      },
    );
  // For a /verify-email request: who held the token's address before Better
  // Auth ran, so the after-hook can compare with the database. Keyed by the
  // request object, so it lives and dies with the request.
  const emailBefore = new WeakMap<Request, { id: string; email: string }>();
  // An impersonated session being signed out, by token, so the after-hook
  // can audit the stop once the sign-out has worked.
  const endingImpersonations = new Map<
    string,
    { id: string; userId: string; impersonatedBy: string }
  >();
  // Paths whose endpoint answers GET: a read. Filled in once the instance
  // exists (below); an `auth.api` call carries no request to ask.
  let readablePaths = new Set<string>();
  const hostnames = (() => {
    const hosts = env.baseUrl ? [new URL(env.baseUrl).hostname] : [];
    return env.local ? [...hosts, "localhost", "127.0.0.1"] : hosts;
  })();
  const auth = betterAuth({
    secret: env.secret,
    logger: { log: logAuthEvent },
    // API errors still become responses; anything else (a database failure)
    // reaches the caller, whose own catch logs the name only.
    onAPIError: { throw: true },
    // One build serves every host in local mode, so the address comes from
    // the request there; otherwise it is the one configured address.
    baseURL: env.baseUrl ?? { allowedHosts: ["localhost:*"] },
    database: drizzleAdapter(db, { provider: "pg", schema, transaction: true }),
    user: {
      modelName: "users",
      // Deletion anonymizes (DM 6.7); Better Auth's is a hard delete.
      deleteUser: { enabled: false },
      // An unconfirmed address can be corrected at once ("Wrong address?
      // Change it"); a confirmed one changes only when the new address
      // confirms, through the verification email above.
      changeEmail: { enabled: true, updateEmailWithoutVerification: true },
    },
    session: {
      modelName: "authSessions",
      // Set only by `verifyStaffSession`, by a direct write after a code
      // check. `input: false` refuses it from any client (/update-session),
      // and the create hook below clears it, so a session Better Auth makes
      // from another (2FA enable, impersonation) never inherits it.
      additionalFields: {
        staffVerifiedAt: { type: "date", required: false, input: false },
      },
    },
    account: {
      modelName: "authAccounts",
      // M5 plan, finding 1: do NOT add `trustedProviders` (least of all
      // "discord"). A trusted provider links to a matching account even when
      // its email is unverified, and Discord lets anyone put an unverified
      // email on their profile: that would sign them in as the victim.
      // Without it, a sign-in links only when the provider says the email is
      // verified, and `requireLocalEmailVerified` (left at its default, true)
      // asks the same of our account.
      accountLinking: { enabled: true },
    },
    verification: { modelName: "authVerifications" },
    advanced: {
      // With a dynamic baseURL Better Auth can't tell https from http, and
      // falls back to NODE_ENV. Browsers accept Secure on http://localhost.
      useSecureCookies: true,
      database: { generateId: () => newId() },
      ipAddress: {
        ipAddressHeaders: ["x-vercel-forwarded-for", "x-forwarded-for"],
      },
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: EMAIL_LINK_SECONDS,
      sendResetPassword: async ({ user, url }) => {
        await mail(user.email, "password_reset", url, EMAIL_LINK_SECONDS);
      },
      onPasswordReset: async ({ user }) => {
        // `user` is as it was before the reset.
        if (!user.emailVerified) {
          await revokeUnprovenSignIns(db, now(), user.id);
        }
        await auditUserChange(db, now(), "user.password.update", user.id);
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      expiresIn: EMAIL_LINK_SECONDS,
      // Runs only for an unverified account, before it is marked verified and
      // before the sign-in this link makes.
      beforeEmailVerification: async (user) => {
        await revokeUnprovenSignIns(db, now(), user.id);
      },
      sendVerificationEmail: async ({ user, url }) => {
        await mail(user.email, "verify_email", url, EMAIL_LINK_SECONDS);
      },
    },
    socialProviders: env.discord
      ? {
          discord: {
            clientId: env.discord.clientId,
            clientSecret: env.discord.clientSecret,
          },
        }
      : {},
    // Serverless memory doesn't last between requests, so the counts live in
    // the database.
    rateLimit: {
      enabled: true,
      storage: "database",
      modelName: "authRateLimits",
      customRules: {
        "/sign-in/magic-link": { window: 600, max: 3 },
        "/request-password-reset": { window: 600, max: 3 },
        // "Send it again (in 0:42)".
        "/send-verification-email": { window: 40, max: 1 },
      },
    },
    hooks: {
      // The same refusal as sign-up, so a reply says nothing about whether
      // an account exists and carries no address.
      before: createAuthMiddleware(async (ctx) => {
        // An impersonated session is read-only (DM 6.4): every write but
        // ending it is refused, whatever the endpoint, so one a later release
        // adds is covered too. Reads pay nothing.
        const method =
          ctx.request?.method ?? (readablePaths.has(ctx.path) ? "GET" : "POST");
        const writes = method !== "GET" && method !== "HEAD";
        const managesFactor = ctx.path.startsWith("/two-factor/");
        if (writes || managesFactor) {
          const token = await ctx.getSignedCookie(
            ctx.context.authCookies.sessionToken.name,
            ctx.context.secret,
          );
          // The sign-in challenge has no session, just the two-factor
          // cookie. No expiry filter: Better Auth decides expiry on its own
          // clock, and judging it by ours could skip the checks below (fail
          // open) when ours runs ahead, as in a replay deployment.
          const [held] = token
            ? await db
                .select({
                  id: authSessions.id,
                  userId: authSessions.userId,
                  impersonatedBy: authSessions.impersonatedBy,
                  staffVerifiedAt: authSessions.staffVerifiedAt,
                  role: users.role,
                  twoFactorEnabled: users.twoFactorEnabled,
                })
                .from(authSessions)
                .innerJoin(users, eq(users.id, authSessions.userId))
                .where(eq(authSessions.token, token))
            : [];
          // Ruling 37: a staff member's factor is managed only from an
          // unlocked session. Otherwise a session alone (a phished magic
          // link, a taken Discord account, no password with
          // `allowPasswordless`) could mint backup codes or enrol another
          // authenticator, and unlock staff tools with it. First enrolment
          // stays open: there is no factor yet to protect.
          if (
            held &&
            managesFactor &&
            hasStaffRole(held.role, "moderator") &&
            held.twoFactorEnabled &&
            held.staffVerifiedAt === null
          ) {
            throw APIError.from("FORBIDDEN", {
              message: "Enter a code to unlock staff tools first.",
              code: STAFF_SESSION_UNVERIFIED,
            });
          }
          if (writes && token && held?.impersonatedBy) {
            if (!IMPERSONATION_EXITS.includes(ctx.path)) {
              throw APIError.from("FORBIDDEN", {
                message: "This session is read-only.",
                code: IMPERSONATION_READ_ONLY,
              });
            }
            if (ctx.path === "/sign-out") {
              endingImpersonations.set(token, {
                id: held.id,
                userId: held.userId,
                impersonatedBy: held.impersonatedBy,
              });
            }
          }
        }
        if (ctx.path === "/verify-email") {
          const claims = tokenClaims(ctx.query?.token);
          if (ctx.request && claims?.updateTo && claims.email) {
            const [holder] = await db
              .select({ id: users.id, email: users.email })
              .from(users)
              .where(eq(users.email, claims.email.toLowerCase()));
            if (holder) emailBefore.set(ctx.request, holder);
          }
          return;
        }
        // Our pages post nothing to /update-user, so every field is refused
        // (Ruling 58): `name` and `image` are free text and a free URL that
        // nothing checks. `changeUsername` is the only rename path: it holds
        // the 30-day wait, the history and the hold that this route would
        // skip. An empty body is Better Auth's own "No fields to update".
        if (ctx.path === "/update-user") {
          const body: unknown = ctx.body;
          if (
            typeof body === "object" &&
            body !== null &&
            Object.keys(body).some((field) => !UPDATE_USER_FIELDS.has(field))
          ) {
            throw new APIError("BAD_REQUEST", {
              message:
                "username" in body || "displayUsername" in body
                  ? "A username is changed from settings."
                  : "Your account is changed from settings.",
            });
          }
        }
        // The display name is the username with the user's capitals (DM 6.3),
        // so it can't carry a name the username check would refuse.
        if (ctx.path === "/sign-up/email") {
          const body: unknown = ctx.body;
          const record =
            typeof body === "object" && body !== null
              ? (body as Record<string, unknown>)
              : {};
          // Age and the legal documents are agreed to on the form (DM 6.2).
          if (record.ageConfirmed !== true || record.accepted !== true) {
            throw new APIError("BAD_REQUEST", {
              message:
                "Confirm your age and accept the terms to create an account.",
            });
          }
          const display = record.displayUsername;
          if (display !== undefined) {
            const typed = record.username;
            if (
              typeof display !== "string" ||
              typeof typed !== "string" ||
              typed.toLowerCase() !== display.toLowerCase()
            ) {
              throw new APIError("BAD_REQUEST", {
                message: "The display name must be the username.",
              });
            }
          }
        }
        const field = ADDRESS_FIELD[ctx.path];
        const body: unknown = ctx.body;
        if (!field || typeof body !== "object" || body === null) return;
        const address = (body as Record<string, unknown>)[field];
        if (typeof address === "string" && /\.invalid$/i.test(address.trim())) {
          throw new APIError("FORBIDDEN", { message: SIGN_UP_CLOSED });
        }
        // With the allowlist set, it names who has an account, so an account
        // can't move to an address outside it either (Ruling 58): the same
        // refusal as sign-up.
        if (
          ctx.path === "/change-email" &&
          typeof address === "string" &&
          !allowedToSignUp(env, address)
        ) {
          throw new APIError("FORBIDDEN", { message: SIGN_UP_CLOSED });
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/sign-out") {
          // `stopImpersonating` audits its own stop; this is the other way
          // an impersonation ends early.
          const token = await ctx.getSignedCookie(
            ctx.context.authCookies.sessionToken.name,
            ctx.context.secret,
          );
          const ended = token && endingImpersonations.get(token);
          if (!token || !ended) return;
          endingImpersonations.delete(token);
          const failed = ctx.context.returned;
          if (failed instanceof APIError && Number(failed.statusCode) >= 400) {
            return;
          }
          await auditImpersonationStop(db, now(), {
            adminUserId: ended.impersonatedBy,
            targetUserId: ended.userId,
            sessionId: ended.id,
            via: "sign-out",
          });
          return;
        }
        if (ctx.path === "/verify-email") {
          // The database decides: the change took effect if the user who held
          // the address now holds another one. A failed, forged or replayed
          // link changes nothing, so it writes nothing.
          const held = ctx.request && emailBefore.get(ctx.request);
          if (!held || !ctx.request) return;
          emailBefore.delete(ctx.request);
          const [row] = await db
            .select({ email: users.email })
            .from(users)
            .where(eq(users.id, held.id));
          if (!row || row.email === held.email) return;
          await auditUserChange(db, now(), "user.email.update", held.id, {
            before: { email: held.email },
            after: { email: row.email, stage: "applied", applied: true },
          });
          return;
        }
        const returned = ctx.context.returned;
        if (
          returned instanceof APIError &&
          Number(returned.statusCode) >= 400
        ) {
          return;
        }
        const changesEmail = ctx.path === "/change-email";
        if (!changesEmail && ctx.path !== "/change-password") return;
        const session = await getSessionFromCtx(ctx);
        if (!session) return;
        const { user } = session;
        if (changesEmail) {
          // What happened, read back: a new address that already belongs to
          // someone changes nothing, and a confirmed account waits for the
          // new address.
          const newEmail = String(ctx.body.newEmail).toLowerCase();
          const [row] = await db
            .select({ email: users.email })
            .from(users)
            .where(eq(users.id, user.id));
          const applied = row?.email === newEmail;
          await auditUserChange(db, now(), "user.email.update", user.id, {
            before: { email: user.email },
            after: {
              email: newEmail,
              stage: applied ? "applied" : "requested",
              applied,
            },
          });
          if (user.emailVerified) {
            const origin = new URL(ctx.context.baseURL).origin;
            await mail(
              user.email,
              "email_change_notice",
              `${origin}${SECURE_ACCOUNT_PATH}`,
            );
          }
        } else {
          await auditUserChange(db, now(), "user.password.update", user.id);
        }
      }),
    },
    disabledPaths: DISABLED_AUTH_PATHS,
    databaseHooks: {
      session: {
        create: {
          // A new session always starts locked for staff tools (DM 6.4).
          before: async (session) => ({
            data: { ...session, staffVerifiedAt: null },
          }),
        },
        update: {
          // Ruling 38: an impersonation never outlives its hour, whatever
          // the client sends. Without the plugin's `dont_remember` cookie a
          // session read would refresh it to the usual seven days. Better
          // Auth refreshes the session the request's cookie names, so that
          // is the one looked up.
          before: async (data, context) => {
            const expiresAt = (data as { expiresAt?: unknown }).expiresAt;
            if (!(expiresAt instanceof Date) || !context) return;
            const token = sessionTokenIn(
              context.headers ?? context.request?.headers,
              context.context.authCookies.sessionToken.name,
            );
            if (!token) return;
            const [row] = await db
              .select({
                createdAt: authSessions.createdAt,
                impersonatedBy: authSessions.impersonatedBy,
              })
              .from(authSessions)
              .where(eq(authSessions.token, token));
            if (!row?.impersonatedBy) return;
            const cap = new Date(
              row.createdAt.getTime() + IMPERSONATION_SECONDS * 1000,
            );
            if (expiresAt.getTime() <= cap.getTime()) return;
            return { data: { ...data, expiresAt: cap } };
          },
        },
      },
      user: {
        create: {
          before: async (user) => {
            const email = user.email.toLowerCase();
            if (/\.invalid$/.test(email) || !allowedToSignUp(env, email)) {
              throw new APIError("FORBIDDEN", { message: SIGN_UP_CLOSED });
            }
          },
          after: async (user, context) => {
            await ensureProfile(db, now(), user.id);
            // Only the email form carries the two boxes (checked in the
            // before-hook). Recording them opens a transaction of our own, so
            // it waits for Better Auth's to commit. If it is lost, the
            // account stays incomplete and `Viewer.complete` catches it.
            if (context?.path !== "/sign-up/email") return;
            await queueAfterTransactionHook(
              async () => {
                await completeSignUp(db, now(), {
                  userId: user.id,
                  ageConfirmed: true,
                  accepted: true,
                });
              },
              {
                onError: (error) => {
                  console.error(
                    `better-auth sign-up completion failed: ${error instanceof Error ? error.name : "unknown"}`,
                  );
                },
              },
            );
          },
        },
      },
    },
    // `tanstackStartCookies` must stay last.
    plugins: [
      admin({
        ac: accessControl,
        roles: ACCESS_ROLES,
        adminRoles: ["admin"],
        defaultRole: "user",
        impersonationSessionDuration: IMPERSONATION_SECONDS,
      }),
      // TOTP for staff (DM 6.4). It challenges password sign-in only; staff
      // tools ask for a code once per session however the person signed in
      // (`verifyStaffSession`). `allowPasswordless`: a Discord or
      // magic-link staff member has no password to confirm with.
      twoFactor({
        issuer: "Gridlocked",
        allowPasswordless: true,
        totpOptions: { period: TOTP_PERIOD_SECONDS },
        schema: { twoFactor: { modelName: "authTwoFactors" } },
      }),
      // The plugin lower-cases `username` (the unique, case-insensitive key)
      // and keeps `displayUsername` as typed. The validator only says yes or
      // no; why a name is refused is `checkUsername`'s to say.
      username({
        minUsernameLength: USERNAME_MIN_LENGTH,
        maxUsernameLength: USERNAME_MAX_LENGTH,
        usernameValidator: async (name) =>
          (await checkUsername(db, now(), name)) === null,
        displayUsernameValidator: (name) => isValidUsernameFormat(name),
      }),
      magicLink({
        expiresIn: MAGIC_LINK_SECONDS,
        storeToken: "hashed",
        sendMagicLink: async ({ email, url }) => {
          await mail(email, "magic_link", url, MAGIC_LINK_SECONDS);
        },
      }),
      // On whenever there is a secret (always, outside local mode). The
      // plugin gives siteverify 10 s and then fails closed.
      ...(env.turnstileSecret
        ? [
            captcha({
              provider: "cloudflare-turnstile",
              secretKey: env.turnstileSecret,
              endpoints: CAPTCHA_PATHS,
              // The widget reports where it ran; a token earned elsewhere
              // fails.
              allowedHostnames: hostnames,
            }),
          ]
        : []),
      tanstackStartCookies(),
    ],
  });
  readablePaths = new Set(
    Object.values(auth.api).flatMap((endpoint) => {
      const { path, options } = endpoint as {
        path?: string;
        options?: { method?: string | string[] };
      };
      const methods = [options?.method ?? []].flat();
      return path && (methods.includes("GET") || methods.includes("*"))
        ? [path]
        : [];
    }),
  );
  return auth;
}

export type Auth = ReturnType<typeof createAuth>;

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
const BASE32_PREFIX = "base32:";

/**
 * A user's confirmed TOTP factor, decrypted with Better Auth's key, or null
 * if they have none. For `verifyStaffSession`, which checks the code itself
 * so it can use the caller's `now` and its own limit. Pass the transaction
 * the check belongs to.
 */
export async function readTwoFactor(
  auth: Auth,
  db: Db,
  userId: string,
): Promise<{
  /** The TOTP secret as bytes, or null if it's in a form we don't read. */
  secret: Uint8Array | null;
  /** Uses up `code` if it's one of the backup codes; true if it was. */
  useBackupCode(code: string): Promise<boolean>;
} | null> {
  const [row] = await db
    .select()
    .from(authTwoFactors)
    .where(
      and(eq(authTwoFactors.userId, userId), eq(authTwoFactors.verified, true)),
    );
  if (!row) return null;
  const { secretConfig } = await auth.$context;
  const plain = await symmetricDecrypt({ key: secretConfig, data: row.secret });
  // The plugin makes plain secrets; an imported base32 one isn't read here.
  const secret = plain.startsWith(BASE32_PREFIX)
    ? null
    : new TextEncoder().encode(plain);
  return {
    secret,
    async useBackupCode(code) {
      let codes: unknown;
      try {
        codes = JSON.parse(
          await symmetricDecrypt({ key: secretConfig, data: row.backupCodes }),
        );
      } catch {
        return false;
      }
      if (!Array.isArray(codes) || !codes.includes(code)) return false;
      const left = await symmetricEncrypt({
        key: secretConfig,
        data: JSON.stringify(codes.filter((c) => c !== code)),
      });
      // Compare-and-set, as the plugin does: of two uses at once, one wins.
      const updated = await db
        .update(authTwoFactors)
        .set({ backupCodes: left })
        .where(
          and(
            eq(authTwoFactors.id, row.id),
            eq(authTwoFactors.backupCodes, row.backupCodes),
          ),
        )
        .returning({ id: authTwoFactors.id });
      return updated.length === 1;
    },
  };
}
