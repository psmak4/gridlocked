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
import { admin, captcha, magicLink } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import * as schema from "@/db/schema";
import { profiles } from "@/db/schema";
import type { Db } from "@/db/types";
import { writeAudit } from "@/audit/log";
import { newId } from "@/lib/ids";
import type { AuthEnv } from "./env";
import { queueEmail } from "./email/outbox";
import type { EmailSender } from "./email/sender";
import type { EmailTemplate } from "./email/templates";

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
        await auditUserChange(db, now(), "user.password.update", user.id);
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      expiresIn: EMAIL_LINK_SECONDS,
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
        const field = ADDRESS_FIELD[ctx.path];
        const body: unknown = ctx.body;
        if (!field || typeof body !== "object" || body === null) return;
        const address = (body as Record<string, unknown>)[field];
        if (typeof address === "string" && /\.invalid$/i.test(address.trim())) {
          throw new APIError("FORBIDDEN", { message: SIGN_UP_CLOSED });
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        const changesEmail = ctx.path === "/change-email";
        if (!changesEmail && ctx.path !== "/change-password") return;
        if (ctx.context.returned instanceof Error) return;
        const session = await getSessionFromCtx(ctx);
        if (!session) return;
        const { user } = session;
        if (changesEmail) {
          await auditUserChange(db, now(), "user.email.update", user.id, {
            before: { email: user.email },
            // `applied` is false while the new address is yet to confirm.
            after: { email: ctx.body.newEmail, applied: !user.emailVerified },
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
            }),
          ]
        : []),
      tanstackStartCookies(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
