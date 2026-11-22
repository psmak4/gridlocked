/**
 * Better Auth (HLD decisions 4-5, DM 6.0) on our own tables. This directory,
 * `auth-client.ts` and `src/server/` are the only places that import it
 * (ESLint enforces that). The constants and helpers are in `shared.ts`, and
 * the request and database hooks in their own files.
 *
 * Better Auth reads its own clock for the rows it writes; everything of ours
 * takes `now` from the caller.
 */
import { queueAfterTransactionHook } from "@better-auth/core/context";
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import {
  admin,
  captcha,
  magicLink,
  twoFactor,
  username,
} from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import * as schema from "@/db/schema";
import { newId } from "@/lib/ids";
import { queueEmail, sendStagedEmail, stageEmail } from "../email/outbox";
import {
  checkUsername,
  isValidUsernameFormat,
  USERNAME_MAX_LENGTH,
  USERNAME_MIN_LENGTH,
} from "../usernames";
import type { Db } from "@/db/types";
import type { AuthEnv } from "../env";
import type { EmailSender } from "../email/sender";
import type { EmailTemplate } from "../email/templates";
import { afterAuthCommit } from "./after-commit";
import { databaseHooks } from "./database-hooks";
import { requestHooks, type AddressProof } from "./request-hooks";
import { captureTransactions } from "./transactions";
import {
  ACCESS_ROLES,
  CAPTCHA_PATHS,
  DISABLED_AUTH_PATHS,
  EMAIL_LINK_SECONDS,
  IMPERSONATION_SECONDS,
  MAGIC_LINK_SECONDS,
  TOTP_PERIOD_SECONDS,
  accessControl,
  logAuthEvent,
  resetHalfMadeSignUp,
  revokeUnprovenSignIns,
  unprovenLinks,
} from "./shared";

export {
  auditImpersonationStop,
  DISABLED_AUTH_PATHS,
  ensureProfile,
  IMPERSONATION_READ_ONLY,
  IMPERSONATION_SECONDS,
  logAuthEvent,
  MAGIC_LINK_SIGN_IN,
  STAFF_SESSION_UNVERIFIED,
  TOTP_PERIOD_SECONDS,
} from "./shared";
export * from "./two-factor";

export type AuthDeps = {
  env: AuthEnv;
  now: () => Date;
  /** Where account emails go; null queues them until a provider is set up. */
  sender: EmailSender | null;
};

/** Queues an account email: with Better Auth's transaction, if one is open. */
export type Mail = (
  to: string,
  template: EmailTemplate,
  url: string,
  lifetimeSeconds?: number,
) => Promise<void>;

export function createAuth(db: Db, deps: AuthDeps) {
  const { env, now, sender } = deps;
  // Better Auth's own transaction, where it has one (sign-up, a reset).
  const transactions = captureTransactions(db);
  // Sign-up calls its email callback inside its transaction: the outbox row
  // is written there, so it commits with the account (M9 Task 2), and is sent
  // once that commits; if the send never happens, the flush sends it.
  // Elsewhere the email is queued and sent at once. A failure is logged by
  // name only and doesn't fail the request: the reply must not depend on
  // the address.
  const mail: Mail = async (
    to: string,
    template: EmailTemplate,
    url: string,
    lifetimeSeconds?: number,
  ) => {
    const at = now();
    const email = {
      to,
      template,
      payload: { url },
      ...(lifetimeSeconds !== undefined && {
        expiresAt: new Date(at.getTime() + lifetimeSeconds * 1000),
      }),
    };
    const onError = (error: unknown) => {
      console.error(
        `better-auth email failed: ${error instanceof Error ? error.name : "unknown"}`,
      );
    };
    const tx = transactions.current();
    if (!tx) {
      try {
        await queueEmail(db, at, email, sender);
      } catch (error) {
        onError(error);
      }
      return;
    }
    const id = await stageEmail(tx, at, email);
    if (!id) return;
    await queueAfterTransactionHook(
      async () => {
        await sendStagedEmail(db, now(), id, sender);
      },
      { onError },
    );
  };
  // For a /verify-email request: who held the token's address before Better
  // Auth ran, so the after-hook can compare with the database. Keyed by the
  // request object, so it lives and dies with the request.
  const emailBefore = new WeakMap<Request, { id: string; email: string }>();
  const proofs = new WeakMap<Request, AddressProof>();
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
    database: drizzleAdapter(transactions.db, {
      provider: "pg",
      schema,
      transaction: true,
    }),
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
      // After the reset has committed, with every session already ended.
      // `user` is as it was before the reset. The work is kept as a job, so
      // a failure here retries instead of being lost (M9 Task 2).
      onPasswordReset: async ({ user }) => {
        await afterAuthCommit(db, now(), {
          event: "password_reset",
          at: now().toISOString(),
          userId: user.id,
          revokeAccountIds: user.emailVerified
            ? []
            : await unprovenLinks(db, user.id),
        });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      expiresIn: EMAIL_LINK_SECONDS,
      // Runs only for an unverified account, once the link is checked,
      // before it is marked verified and before the sign-in this link makes.
      // From a browser not signed in to the account, the half-made sign-up
      // goes too (M9 Task 1); the gate then sends the owner to finish it.
      beforeEmailVerification: async (user, request) => {
        const proof = request && proofs.get(request);
        if (proof?.signedIn !== user.id) {
          await resetHalfMadeSignUp(db, now(), user.id);
        }
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
    hooks: requestHooks({
      db,
      env,
      now,
      mail,
      emailBefore,
      proofs,
      endingImpersonations,
      readablePaths: () => readablePaths,
    }),
    disabledPaths: DISABLED_AUTH_PATHS,
    databaseHooks: databaseHooks({ db, env, now, transactions }),
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
