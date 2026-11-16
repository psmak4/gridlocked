/** Better Auth's database hooks (split out of `auth.ts` in M7). */
import type { BetterAuthOptions } from "better-auth";
import { queueAfterTransactionHook } from "@better-auth/core/context";
import { APIError } from "better-auth/api";
import { eq } from "drizzle-orm";
import { authSessions } from "@/db/schema";
import { completeSignUp } from "../consent";
import type { Db } from "@/db/types";
import type { AuthEnv } from "../env";
import {
  IMPERSONATION_SECONDS,
  SIGN_UP_CLOSED,
  allowedToSignUp,
  ensureProfile,
  sessionTokenIn,
} from "./shared";

/** Better Auth's `databaseHooks`: what runs around its own row writes. */
export function databaseHooks({
  db,
  env,
  now,
}: {
  db: Db;
  env: AuthEnv;
  now: () => Date;
}): NonNullable<BetterAuthOptions["databaseHooks"]> {
  return {
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
  };
}
