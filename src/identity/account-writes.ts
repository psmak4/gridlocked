/**
 * The account writes Better Auth's hooks and the `identity_after_commit` job
 * share (moved out of `auth/shared.ts` in M9 Task 2). Plain Drizzle, no Better
 * Auth import, so the tick function can run them without bundling it.
 */
import { and, eq, inArray, ne } from "drizzle-orm";
import { writeAudit, type AuditEntry } from "@/audit/log";
import {
  authAccounts,
  authSessions,
  legalAcceptances,
  profiles,
  users,
} from "@/db/schema";
import type { Db } from "@/db/types";

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

/** The `audit_log` entry for something a user did to their own sign-in details. */
export function userChangeEntry(
  action: "user.email.update" | "user.password.update",
  userId: string,
  change: {
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  } = { before: null, after: null },
): AuditEntry {
  return {
    actorUserId: userId,
    actorKind: "user",
    actorLabel: null,
    action,
    entityType: "user",
    entityId: userId,
    ...change,
    reason: null,
    requestId: null,
  };
}

/** One `audit_log` row for something a user did to their own sign-in details. */
export function auditUserChange(
  db: Db,
  now: Date,
  action: "user.email.update" | "user.password.update",
  userId: string,
  change?: {
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  },
): Promise<string> {
  return writeAudit(db, now, userChangeEntry(action, userId, change));
}

/**
 * Better Auth's magic link strips every link and session an unverified account
 * gathered before its address was proved (revokeUnprovenAccountAccess); a
 * verification link or a reset does not. Without this, someone who signed in
 * with Discord on an address they don't own (Discord allows an unverified
 * email) keeps that way in after the owner proves the address. Credentials
 * stay: a reset or sign-up password is the owner's to choose. Call it while
 * the account is still unverified.
 *
 * With `only`, just those links go, and no session: a reset that has already
 * ended every session names the links it found, so a retry later can't take
 * one the owner added since (M9 Task 2).
 */
export async function revokeUnprovenSignIns(
  db: Db,
  now: Date,
  userId: string,
  only?: { accountIds: string[] },
): Promise<void> {
  if (only && only.accountIds.length === 0) return;
  await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const linked = await t
      .select({ id: authAccounts.id, providerId: authAccounts.providerId })
      .from(authAccounts)
      .where(
        and(
          eq(authAccounts.userId, userId),
          ne(authAccounts.providerId, "credential"),
          only ? inArray(authAccounts.id, only.accountIds) : undefined,
        ),
      );
    // Every session goes, links or not: nothing that predates the proof is
    // known to be the owner's. The sign-in the proof makes comes after.
    if (!only) {
      await t.delete(authSessions).where(eq(authSessions.userId, userId));
    }
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
 * A sign-up whose address isn't proved yet may not be the address owner's
 * (M5's carry-over, M9 Task 1). When the proof comes from a browser that
 * isn't signed in to the account, everything the first browser chose goes:
 * the password, the age and terms record, the username and name. The owner
 * then finishes signing up as themselves (`/welcome`). The username isn't
 * kept in the history: it was never the owner's to hold. Call it while the
 * account is still unverified, and only once the proof has been checked.
 */
export async function resetHalfMadeSignUp(
  db: Db,
  now: Date,
  userId: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    await t
      .delete(authAccounts)
      .where(
        and(
          eq(authAccounts.userId, userId),
          eq(authAccounts.providerId, "credential"),
        ),
      );
    await t
      .update(profiles)
      .set({ ageConfirmedAt: null })
      .where(eq(profiles.userId, userId));
    await t.delete(legalAcceptances).where(eq(legalAcceptances.userId, userId));
    await t
      .update(users)
      .set({ username: null, displayUsername: null, name: "" })
      .where(eq(users.id, userId));
    await writeAudit(t, now, {
      actorUserId: null,
      actorKind: "system",
      actorLabel: "email proof",
      action: "user.sign_up.reset",
      entityType: "user",
      entityId: userId,
      before: null,
      after: null,
      reason: null,
      requestId: null,
    });
  });
}

/** The `audit_log` entry for an impersonation that ended (DM 6.4, 6.6). */
export function impersonationStopEntry(input: {
  adminUserId: string;
  targetUserId: string;
  sessionId: string;
  via: "stop" | "sign-out";
}): AuditEntry {
  return {
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
  };
}

/** Writes that entry. */
export function auditImpersonationStop(
  db: Db,
  now: Date,
  input: Parameters<typeof impersonationStopEntry>[0],
): Promise<string> {
  return writeAudit(db, now, impersonationStopEntry(input));
}

/** The ids of an account's sign-in links other than its password. */
export async function unprovenLinks(db: Db, userId: string): Promise<string[]> {
  const rows = await db
    .select({ id: authAccounts.id })
    .from(authAccounts)
    .where(
      and(
        eq(authAccounts.userId, userId),
        ne(authAccounts.providerId, "credential"),
      ),
    );
  return rows.map((r) => r.id);
}
