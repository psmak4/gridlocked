/** Better Auth's request hooks (split out of `auth.ts` in M7). */
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
} from "better-auth/api";
import { eq } from "drizzle-orm";
import { authSessions, users } from "@/db/schema";
import { hasStaffRole } from "../roles";
import type { Db } from "@/db/types";
import type { AuthEnv } from "../env";
import type { Mail } from "./index";
import {
  ADDRESS_FIELD,
  IMPERSONATION_EXITS,
  IMPERSONATION_READ_ONLY,
  SECURE_ACCOUNT_PATH,
  SIGN_UP_CLOSED,
  STAFF_SESSION_UNVERIFIED,
  UPDATE_USER_FIELDS,
  allowedToSignUp,
  auditImpersonationStop,
  auditUserChange,
  tokenClaims,
} from "./shared";

export type RequestHookContext = {
  db: Db;
  env: AuthEnv;
  now: () => Date;
  mail: Mail;
  /** For a /verify-email request: who held the token's address before Better Auth ran. */
  emailBefore: WeakMap<Request, { id: string; email: string }>;
  /** An impersonated session being signed out, by token. */
  endingImpersonations: Map<
    string,
    { id: string; userId: string; impersonatedBy: string }
  >;
  /** Paths whose endpoint answers GET, known once the instance exists. */
  readablePaths: () => Set<string>;
};

/** Better Auth's `hooks`: the request middleware before and after every endpoint. */
export function requestHooks({
  db,
  env,
  now,
  mail,
  emailBefore,
  endingImpersonations,
  readablePaths,
}: RequestHookContext) {
  return {
    // The same refusal as sign-up, so a reply says nothing about whether
    // an account exists and carries no address.
    before: createAuthMiddleware(async (ctx) => {
      // An impersonated session is read-only (DM 6.4): every write but
      // ending it is refused, whatever the endpoint, so one a later release
      // adds is covered too. Reads pay nothing.
      const method =
        ctx.request?.method ?? (readablePaths().has(ctx.path) ? "GET" : "POST");
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
      if (returned instanceof APIError && Number(returned.statusCode) >= 400) {
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
  };
}
