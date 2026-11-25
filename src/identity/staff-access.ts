/**
 * The staff two-step (DM 6.4, M5 decision 5 and ruling 34). Staff tools ask
 * for a TOTP or backup code once per session, however the person signed in:
 * the two-factor plugin only challenges password sign-in, so a magic link or
 * Discord would otherwise skip it. `auth_sessions.staff_verified_at` is set
 * here and nowhere else; no sign-in sets it, password and TOTP included.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { writeAudit, type AuditEntry } from "@/audit/log";
import { authSessions, staffTotpSteps } from "@/db/schema";
import type { Db } from "@/db/types";
import { openReviewItem } from "@/reference/review";
import { readTwoFactor, TOTP_PERIOD_SECONDS, type Auth } from "./auth";
import { hasStaffRole } from "./staff-roles";
import {
  consumeRateLimitCount,
  IdentityError,
  releaseRateLimit,
  requireViewer,
  type Viewer,
} from "./viewer";

/** Failed attempts per user per window; then it waits (ruling 39). */
const VERIFY_LIMIT = { windowSeconds: 900, max: 5 };
const TOTP_DIGITS = 6;
/** One step either side, for a clock that's a little off. */
const TOTP_WINDOW = 1;

export { requireStaff } from "./staff-roles";

/** RFC 4226: the code for one counter step. */
async function hotp(key: CryptoKey, counter: number): Promise<string> {
  const message = new ArrayBuffer(8);
  new DataView(message).setBigUint64(0, BigInt(counter), false);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, message));
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) |
    (mac[offset + 1]! << 16) |
    (mac[offset + 2]! << 8) |
    mac[offset + 3]!;
  return String(binary % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, "0");
}

/** Compares every character, so the time taken says nothing. */
function sameCode(a: string, b: string): boolean {
  let difference = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return difference === 0;
}

/**
 * RFC 6238 at `now`, with Better Auth's settings (HMAC-SHA-1, 6 digits, the
 * plugin's period), so an authenticator's code matches. Ours rather than the
 * plugin's because the plugin reads the system clock. Gives the step the
 * code belongs to, or null; every step is checked, so the time taken says
 * nothing about which.
 */
async function totpMatches(
  secret: Uint8Array,
  code: string,
  now: Date,
): Promise<number | null> {
  const key = await crypto.subtle.importKey(
    "raw",
    secret as BufferSource,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const counter = Math.floor(now.getTime() / (TOTP_PERIOD_SECONDS * 1000));
  let matched: number | null = null;
  for (let step = -TOTP_WINDOW; step <= TOTP_WINDOW; step++) {
    if (sameCode(code, await hotp(key, counter + step))) {
      matched = counter + step;
    }
  }
  return matched;
}

/**
 * Takes TOTP step `step` for the user if it's later than the last one taken,
 * in one atomic upsert; false means the code was used already (a replay).
 */
async function takeTotpStep(
  tx: Db,
  userId: string,
  step: number,
): Promise<boolean> {
  const taken = await tx
    .insert(staffTotpSteps)
    .values({ userId, lastStep: step })
    .onConflictDoUpdate({
      target: staffTotpSteps.userId,
      set: { lastStep: sql`excluded.last_step` },
      setWhere: sql`${staffTotpSteps.lastStep} < excluded.last_step`,
    })
    .returning({ userId: staffTotpSteps.userId });
  return taken.length === 1;
}

/**
 * Unlocks staff tools for the viewer's session: checks `code` (a TOTP code
 * for a step later than the last one taken, or one of the backup codes,
 * which it uses up), then sets `auth_sessions.staff_verified_at` with the
 * audit `staff.session.verify`, in one transaction. Five failed attempts per
 * user per 15 minutes, then every attempt waits for the window to end, so a
 * guesser gets nowhere; a right code costs nothing (ruling 39). Each failure
 * writes `staff.session.verify_failed`; the fifth also writes
 * `staff.session.verify_locked` and opens a warning review item. The code is
 * never logged.
 *
 * `realNow` (default `now`) is the time on the person's own clock, which on a
 * hosted replay isn't the site's (M9 Task 13): an authenticator app's codes
 * and the wait after failed attempts go by it, and what's written by `now`.
 */
export async function verifyStaffSession(
  auth: Auth,
  db: Db,
  now: Date,
  input: { viewer: Viewer; code: string; realNow?: Date },
): Promise<void> {
  const realNow = input.realNow ?? now;
  const v = requireViewer(input.viewer);
  if (v.impersonatedBy !== null) throw new IdentityError("read_only");
  if (v.banned || !hasStaffRole(v.role, "moderator")) {
    throw new IdentityError("forbidden");
  }
  if (!v.twoFactorEnabled) throw new IdentityError("staff_two_factor_required");
  // Ruling 40: the attempt is counted before the code is checked, by one
  // atomic upsert, so attempts made at once can't all read a count under the
  // limit. A right code gives its attempt back, so only failures count.
  const limitKey = `staff-verify:${v.userId}`;
  const attempts = await consumeRateLimitCount(
    db,
    realNow,
    limitKey,
    VERIFY_LIMIT,
  );
  if (attempts > VERIFY_LIMIT.max) throw new IdentityError("rate_limited");

  const code = input.code.trim();
  const unlocked = await db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const factor = await readTwoFactor(auth, tx, v.userId);
    if (!factor) throw new IdentityError("staff_two_factor_required");
    let method: "totp" | "backup_code";
    const step =
      /^\d{6}$/.test(code) && factor.secret
        ? await totpMatches(factor.secret, code, realNow)
        : null;
    if (step !== null) {
      // A replayed code is a failure, like a wrong one.
      if (!(await takeTotpStep(tx, v.userId, step))) return false;
      method = "totp";
    } else if (await factor.useBackupCode(code)) {
      method = "backup_code";
    } else {
      // Nothing to write; the attempt stays counted.
      return false;
    }

    const updated = await tx
      .update(authSessions)
      .set({ staffVerifiedAt: now })
      .where(
        and(
          eq(authSessions.id, v.sessionId),
          eq(authSessions.userId, v.userId),
          isNull(authSessions.impersonatedBy),
        ),
      )
      .returning({ id: authSessions.id });
    // The session went (signed out, revoked); the backup code stays unused.
    if (updated.length !== 1) throw new IdentityError("unauthenticated");

    await writeAudit(tx, now, {
      ...asSelf(v),
      action: "staff.session.verify",
      after: { method, sessionId: v.sessionId },
    });
    return true;
  });
  if (!unlocked) {
    await recordFailure(db, now, v, code, attempts);
    throw new IdentityError("invalid_code");
  }
  await releaseRateLimit(db, limitKey);
}

/** The audit fields for a staff member acting on their own account. */
function asSelf(v: Viewer): Omit<AuditEntry, "action" | "after"> {
  return {
    actorUserId: v.userId,
    actorKind: v.role === "admin" ? "admin" : "moderator",
    actorLabel: null,
    entityType: "user",
    entityId: v.userId,
    before: null,
    reason: null,
    requestId: null,
  };
}

/**
 * The audit for a failed code, saying which kind was tried and never the
 * code; on the attempt that reaches the limit, the lock-out too, with a
 * review item so an admin sees it.
 */
async function recordFailure(
  db: Db,
  now: Date,
  v: Viewer,
  code: string,
  attempts: number,
): Promise<void> {
  await db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    await writeAudit(tx, now, {
      ...asSelf(v),
      action: "staff.session.verify_failed",
      after: {
        method: /^\d{6}$/.test(code) ? "totp" : "backup_code",
        sessionId: v.sessionId,
      },
    });
    if (attempts !== VERIFY_LIMIT.max) return;
    await writeAudit(tx, now, {
      ...asSelf(v),
      action: "staff.session.verify_locked",
      after: { attempts, windowSeconds: VERIFY_LIMIT.windowSeconds },
    });
    await openReviewItem(tx, now, {
      kind: "staff_verify_locked",
      severity: "warning",
      seasonId: null,
      details: { userId: v.userId },
      dedupeKey: `staff_verify_locked:${v.userId}`,
    });
  });
}
