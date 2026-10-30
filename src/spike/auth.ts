/**
 * Spike: Better Auth (HLD decisions 4–5) on the spike database, with email and
 * password and the admin plugin. `tanstackStartCookies` must stay last.
 *
 * One build is deployed to several hosts, so the base URL is taken from the
 * request, limited to the hosts the spike uses.
 */
import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";
import type { Db } from "@/db/types";
import * as authSchema from "./auth-schema";
import { withDb } from "./db";

export function createAuth(db: Db) {
  return betterAuth({
    baseURL: {
      allowedHosts: [
        "localhost:*",
        "*.vercel.app",
        "*.netlify.app",
        "*.workers.dev",
        "*.neon.tech",
      ],
    },
    database: drizzleAdapter(db, { provider: "pg", schema: authSchema }),
    emailAndPassword: { enabled: true },
    plugins: [admin(), tanstackStartCookies()],
  });
}

export type Auth = ReturnType<typeof createAuth>;

/** Runs `fn` with an auth instance on this request's database (see db.ts). */
export function withAuth<T>(fn: (auth: Auth) => Promise<T>): Promise<T> {
  return withDb((db) => fn(createAuth(db)));
}
