/**
 * Better Auth (HLD decisions 4-5, DM 6.0) on our own tables. This file and
 * `auth-client.ts` and `src/server/` are the only places that import it
 * (ESLint enforces that).
 *
 * Better Auth reads its own clock for the rows it writes; everything of ours
 * takes `now` from the caller.
 */
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { admin } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import * as schema from "@/db/schema";
import { profiles } from "@/db/schema";
import type { Db } from "@/db/types";
import { newId } from "@/lib/ids";
import type { AuthEnv } from "./env";

export type AuthDeps = {
  env: AuthEnv;
  now: () => Date;
};

/**
 * Staff actions that need an audit row in the same transaction are ours (DM
 * 6.6), so no admin endpoint is reachable over HTTP except the two that only
 * the plugin can do: minting and ending an impersonation session.
 */
const ADMIN_PATHS_OVER_HTTP = [
  "/admin/impersonate-user",
  "/admin/stop-impersonating",
];
const ADMIN_PATHS = [
  "/admin/ban-user",
  "/admin/create-user",
  "/admin/get-user",
  "/admin/has-permission",
  "/admin/list-user-sessions",
  "/admin/list-users",
  "/admin/remove-user",
  "/admin/revoke-user-session",
  "/admin/revoke-user-sessions",
  "/admin/set-role",
  "/admin/set-user-password",
  "/admin/unban-user",
  "/admin/update-user",
];
export const DISABLED_AUTH_PATHS = [
  ...ADMIN_PATHS.filter((path) => !ADMIN_PATHS_OVER_HTTP.includes(path)),
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

export function createAuth(db: Db, deps: AuthDeps) {
  const { env, now } = deps;
  return betterAuth({
    secret: env.secret,
    // One build serves every host in local mode, so the address comes from
    // the request there; otherwise it is the one configured address.
    baseURL: env.baseUrl ?? { allowedHosts: ["localhost:*"] },
    database: drizzleAdapter(db, { provider: "pg", schema, transaction: true }),
    user: {
      modelName: "users",
      // Deletion anonymizes (DM 6.7); Better Auth's is a hard delete.
      deleteUser: { enabled: false },
    },
    session: { modelName: "authSessions" },
    account: { modelName: "authAccounts" },
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
    },
    // Serverless memory doesn't last between requests, so the counts live in
    // the database.
    rateLimit: {
      enabled: true,
      storage: "database",
      modelName: "authRateLimits",
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
    plugins: [admin(), tanstackStartCookies()],
  });
}

export type Auth = ReturnType<typeof createAuth>;
