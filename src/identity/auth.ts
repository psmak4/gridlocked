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
import { admin, captcha, magicLink, username } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import { and, eq, inArray, ne } from "drizzle-orm";
import * as schema from "@/db/schema";
import { authAccounts, authSessions, profiles, users } from "@/db/schema";
import type { Db } from "@/db/types";
import { writeAudit } from "@/audit/log";
import { newId } from "@/lib/ids";
import type { AuthEnv } from "./env";
import { queueEmail } from "./email/outbox";
import type { EmailSender } from "./email/sender";
import type { EmailTemplate } from "./email/templates";
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
 * 6.6), so no admin endpoint is reachable over HTTP except the two that only
 * the plugin can do: minting and ending an impersonation session. The list is
 * read from the plugin, so an endpoint a later release adds is closed too.
 */
const ADMIN_PATHS_OVER_HTTP = [
  "/admin/impersonate-user",
  "/admin/stop-impersonating",
];
export const DISABLED_AUTH_PATHS = [
  ...Object.values(admin().endpoints)
    .map((endpoint) => endpoint.path)
    .filter((path) => !ADMIN_PATHS_OVER_HTTP.includes(path)),
  // `deleteUser.enabled: false` makes these refuse, but they would still be
  // routed; Better Auth's deletion is a hard delete (DM 6.0).
  "/delete-user",
  "/delete-user/callback",
  // Sign-in is by email, magic link or Discord, never by username, and
  // availability is `checkUsername`'s to answer, not an open endpoint.
  // Read from the plugin, like the admin list.
  ...Object.values(username().endpoints).map((endpoint) => endpoint.path),
];

/** Why a sign-up is refused. No address in it: errors reach logs. */
const SIGN_UP_CLOSED = "Sign-up isn't open for this address.";

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
  const hostnames = (() => {
    const hosts = env.baseUrl ? [new URL(env.baseUrl).hostname] : [];
    return env.local ? [...hosts, "localhost", "127.0.0.1"] : hosts;
  })();
  return betterAuth({
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
    session: { modelName: "authSessions" },
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
        // `changeUsername` is the only rename path: it holds the 30-day wait,
        // the history and the hold that this route would skip.
        if (ctx.path === "/update-user") {
          const body: unknown = ctx.body;
          if (
            typeof body === "object" &&
            body !== null &&
            ("username" in body || "displayUsername" in body)
          ) {
            throw new APIError("BAD_REQUEST", {
              message: "A username is changed from settings.",
            });
          }
        }
        const field = ADDRESS_FIELD[ctx.path];
        const body: unknown = ctx.body;
        if (!field || typeof body !== "object" || body === null) return;
        const address = (body as Record<string, unknown>)[field];
        if (typeof address === "string" && /\.invalid$/i.test(address.trim())) {
          throw new APIError("FORBIDDEN", { message: SIGN_UP_CLOSED });
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
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
      user: {
        create: {
          before: async (user) => {
            const email = user.email.toLowerCase();
            const allowlist = env.signUpAllowlist;
            if (
              /\.invalid$/.test(email) ||
              (allowlist !== null && !allowlist.includes(email))
            ) {
              throw new APIError("FORBIDDEN", { message: SIGN_UP_CLOSED });
            }
          },
          after: async (user) => {
            await ensureProfile(db, now(), user.id);
          },
        },
      },
    },
    // `tanstackStartCookies` must stay last.
    plugins: [
      admin(),
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
}

export type Auth = ReturnType<typeof createAuth>;
