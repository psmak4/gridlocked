/**
 * Who is making a request, and the checks a server function runs on them
 * (DM 6.4, 6.11). Nothing here imports Better Auth: `src/server/session.ts`
 * reads the session and builds a `Viewer`.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { authRateLimits, profiles, type UserRole } from "@/db/schema";
import type { Db } from "@/db/types";
import { newId } from "@/lib/ids";
import { IdentityError } from "./identity-error";

export type Profile = typeof profiles.$inferSelect;

export type Viewer = {
  userId: string;
  role: UserRole;
  /** Banned now: `banned`, with no end or an end still to come. */
  banned: boolean;
  username: string | null;
  displayUsername: string | null;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  sessionId: string;
  /** The admin's id when this session is an impersonation. */
  impersonatedBy: string | null;
  staffVerifiedAt: Date | null;
  profile: Profile;
  /** Has a username, has confirmed their age and has no legal document left to accept. */
  complete: boolean;
};

export { IdentityError, type IdentityErrorCode } from "./identity-error";

export function requireViewer(viewer: Viewer | null): Viewer {
  if (!viewer) throw new IdentityError("unauthenticated");
  return viewer;
}

/** Signed in and done with "Finish signing up". */
export function requireComplete(viewer: Viewer | null): Viewer {
  const v = requireViewer(viewer);
  if (!v.complete) throw new IdentityError("incomplete");
  return v;
}

/** Complete, and not an admin looking through someone's session (read-only). */
export function requireWritable(viewer: Viewer | null): Viewer {
  const v = requireComplete(viewer);
  if (v.impersonatedBy !== null) throw new IdentityError("read_only");
  return v;
}

/** May write posts and chat: verified, active, and not impersonated. */
export function canPost(viewer: Viewer | null): Viewer {
  const v = requireWritable(viewer);
  if (!v.emailVerified) throw new IdentityError("unverified");
  if (v.profile.status !== "active") throw new IdentityError("inactive");
  return v;
}

const TOUCH_INTERVAL_MS = 15 * 60_000;

const utcDay = (date: Date) => date.toISOString().slice(0, 10);

/**
 * Records that the viewer is here (HLD §11.4): `last_seen_at` at most every 15
 * minutes, so idle sessions don't keep the database awake, and `days_visited`
 * once per UTC day. Returns the viewer with the fresh profile.
 */
export async function touchViewer(
  db: Db,
  now: Date,
  viewer: Viewer,
): Promise<Viewer> {
  const seen = viewer.profile.lastSeenAt;
  const newDay = seen === null || utcDay(seen) !== utcDay(now);
  if (!newDay && now.getTime() - seen.getTime() < TOUCH_INTERVAL_MS) {
    return viewer;
  }
  // Only the request that still sees the old `last_seen_at` writes, so two at
  // once count a day once. The compare needs the stored value to round-trip
  // exactly: every write is a JS Date, in milliseconds. A write of SQL
  // `now()` (microseconds) would read back truncated, never match, and stop
  // `last_seen_at` for good.
  const [updated] = await db
    .update(profiles)
    .set({
      lastSeenAt: now,
      daysVisited: newDay
        ? sql`${profiles.daysVisited} + 1`
        : profiles.daysVisited,
    })
    .where(
      and(
        eq(profiles.userId, viewer.userId),
        seen === null
          ? isNull(profiles.lastSeenAt)
          : eq(profiles.lastSeenAt, seen),
      ),
    )
    .returning();
  return updated ? { ...viewer, profile: updated } : viewer;
}

/**
 * A fixed-window limit on `key` over Better Auth's `auth_rate_limits` table:
 * true if this attempt is within `max` for the window that began at the first
 * attempt, false if not. Refused attempts are counted too. Prefix the key
 * (`join:<ip>`) so it can't meet one of Better Auth's own.
 */
export async function consumeRateLimit(
  db: Db,
  now: Date,
  key: string,
  { windowSeconds, max }: { windowSeconds: number; max: number },
): Promise<boolean> {
  const nowMs = now.getTime();
  const expired = sql`${nowMs} - ${authRateLimits.lastRequest} >= ${windowSeconds * 1000}`;
  const [row] = await db
    .insert(authRateLimits)
    .values({ id: newId(), key, count: 1, lastRequest: nowMs })
    .onConflictDoUpdate({
      target: authRateLimits.key,
      set: {
        count: sql`case when ${expired} then 1 else ${authRateLimits.count} + 1 end`,
        lastRequest: sql`case when ${expired} then ${nowMs} else ${authRateLimits.lastRequest} end`,
      },
    })
    .returning({ count: authRateLimits.count });
  return (row?.count ?? 1) <= max;
}

/**
 * Gives back one attempt counted by `consumeRateLimit`, for limits that
 * count only failures: consume first (one atomic upsert, so a burst can't
 * slip past), then release when the attempt turns out to be good.
 */
export async function releaseRateLimit(db: Db, key: string): Promise<void> {
  await db
    .update(authRateLimits)
    .set({ count: sql`greatest(${authRateLimits.count} - 1, 0)` })
    .where(eq(authRateLimits.key, key));
}
