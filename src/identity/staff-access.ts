/**
 * The staff two-step (DM 6.4, M5 decision 5 and ruling 34). Staff tools ask
 * for a TOTP or backup code once per session, however the person signed in:
 * the two-factor plugin only challenges password sign-in, so a magic link or
 * Discord would otherwise skip it. `auth_sessions.staff_verified_at` is set
 * here and nowhere else; no sign-in sets it, password and TOTP included.
 */
import { and, eq, isNull } from "drizzle-orm";
import { writeAudit } from "@/audit/log";
import { authSessions } from "@/db/schema";
import type { Db } from "@/db/types";
import { readTwoFactor, TOTP_PERIOD_SECONDS, type Auth } from "./auth";
import { hasStaffRole, type StaffRole } from "./roles";
import {
  consumeRateLimit,
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

/** Staff with at least `role`, an unlocked session, and not impersonated. */
export function requireStaff(viewer: Viewer | null, role: StaffRole): Viewer {
  const v = requireViewer(viewer);
  if (v.impersonatedBy !== null) throw new IdentityError("read_only");
  if (v.banned || !hasStaffRole(v.role, role)) {
    throw new IdentityError("forbidden");
  }
  if (!v.twoFactorEnabled) throw new IdentityError("staff_two_factor_required");
  if (v.staffVerifiedAt === null) {
    throw new IdentityError("staff_session_unverified");
  }
  return v;
}

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
 * plugin's because the plugin reads the system clock.
 */
async function totpMatches(
  secret: Uint8Array,
  code: string,
  now: Date,
): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    secret as BufferSource,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const counter = Math.floor(now.getTime() / (TOTP_PERIOD_SECONDS * 1000));
  let matched = false;
  for (let step = -TOTP_WINDOW; step <= TOTP_WINDOW; step++) {
    matched = sameCode(code, await hotp(key, counter + step)) || matched;
  }
  return matched;
}

/**
 * Unlocks staff tools for the viewer's session: checks `code` (a TOTP code,
 * or one of the backup codes, which it uses up), then sets
 * `auth_sessions.staff_verified_at` with the audit `staff.session.verify`, in
 * one transaction. Five failed attempts per user per 15 minutes, then every
 * attempt waits for the window to end, so a guesser gets nowhere; a right
 * code costs nothing (ruling 39). The code is never logged.
 */
export async function verifyStaffSession(
  auth: Auth,
  db: Db,
  now: Date,
  input: { viewer: Viewer; code: string },
): Promise<void> {
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
  if (!(await consumeRateLimit(db, now, limitKey, VERIFY_LIMIT))) {
    throw new IdentityError("rate_limited");
  }

  const code = input.code.trim();
  const unlocked = await db.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const factor = await readTwoFactor(auth, tx, v.userId);
    if (!factor) throw new IdentityError("staff_two_factor_required");
    let method: "totp" | "backup_code";
    if (
      /^\d{6}$/.test(code) &&
      factor.secret &&
      (await totpMatches(factor.secret, code, now))
    ) {
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
      actorUserId: v.userId,
      actorKind: v.role === "admin" ? "admin" : "moderator",
      actorLabel: null,
      action: "staff.session.verify",
      entityType: "user",
      entityId: v.userId,
      before: null,
      after: { method, sessionId: v.sessionId },
      reason: null,
      requestId: null,
    });
    return true;
  });
  if (!unlocked) throw new IdentityError("invalid_code");
  await releaseRateLimit(db, limitKey);
}
