/**
 * Trust levels (DM 6.5, HLD §7.4). The nightly job recomputes each recently
 * seen user's level from their counts; a moderator can fix a level by hand,
 * which locks it. Going quiet never lowers a level: only an upheld moderation
 * action does.
 *
 * Posts and upheld actions come from the forum, which M7 adds. M5's default
 * `TrustCounts` returns zeros, so nobody passes TL0 until M7 supplies real
 * counts.
 */
import { and, asc, eq, gt, gte } from "drizzle-orm";
import { writeAudit } from "@/audit/log";
import { profiles, trustLevelChanges, users } from "@/db/schema";
import type { Db } from "@/db/types";
import { newId } from "@/lib/ids";
import { getSetting } from "@/settings";
import type { SettingValue } from "@/settings/defaults";
import { requireReason } from "@/staff/roster";
import { IdentityError } from "./viewer";

export type TrustLevel = 0 | 1 | 2 | 3;
export type TrustThresholds = SettingValue<"trust_thresholds">;

export interface TrustInput {
  current: number;
  daysVisited: number;
  posts: number;
  reputation: number;
  upheldActions: number;
  accountAgeDays: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The level a user's counts earn: the highest whose numbers are all met. It
 * never returns less than `current` unless there is an upheld action.
 */
export function computeTrustLevel(
  input: TrustInput,
  thresholds: TrustThresholds,
): TrustLevel {
  const meets = (t: TrustThresholds["tl1"]) =>
    input.daysVisited >= t.daysVisited &&
    input.posts >= t.posts &&
    input.reputation >= t.reputation &&
    input.accountAgeDays >= t.accountAgeDays;
  const earned: TrustLevel = meets(thresholds.tl3)
    ? 3
    : meets(thresholds.tl2)
      ? 2
      : meets(thresholds.tl1)
        ? 1
        : 0;
  if (input.upheldActions > 0) return earned;
  return Math.max(input.current, earned) as TrustLevel;
}

/** What the forum knows about each user; M7 supplies the real one. */
export type TrustCounts = (
  db: Db,
  userIds: string[],
) => Promise<Map<string, { posts: number; upheldActions: number }>>;

export const noCounts: TrustCounts = async (_db, userIds) =>
  new Map(userIds.map((id) => [id, { posts: 0, upheldActions: 0 }]));

const ACTIVE_WINDOW_DAYS = 30;

/**
 * Recomputes the level of every active profile seen in the last 30 days, in
 * batches ordered by user id, leaving locked profiles alone. Each change is
 * one row in `trust_level_changes` (source `auto`), written with the update.
 * A second run on the same counts changes nothing.
 */
export async function recomputeTrustLevels(
  db: Db,
  now: Date,
  {
    counts = noCounts,
    batch = 1000,
  }: { counts?: TrustCounts; batch?: number } = {},
): Promise<{ changed: number }> {
  const thresholds = await getSetting(db, "trust_thresholds");
  const since = new Date(now.getTime() - ACTIVE_WINDOW_DAYS * DAY_MS);
  let changed = 0;
  let after: string | null = null;
  for (;;) {
    const rows = await db
      .select({
        userId: profiles.userId,
        trustLevel: profiles.trustLevel,
        daysVisited: profiles.daysVisited,
        reputation: profiles.reputation,
        createdAt: users.createdAt,
      })
      .from(profiles)
      .innerJoin(users, eq(users.id, profiles.userId))
      .where(
        and(
          eq(profiles.status, "active"),
          eq(profiles.trustLevelLocked, false),
          gte(profiles.lastSeenAt, since),
          after === null ? undefined : gt(profiles.userId, after),
        ),
      )
      .orderBy(asc(profiles.userId))
      .limit(batch);
    if (rows.length === 0) break;
    after = rows[rows.length - 1]!.userId;

    const forum = await counts(
      db,
      rows.map((r) => r.userId),
    );
    const moves = rows.flatMap((r) => {
      const c = forum.get(r.userId) ?? { posts: 0, upheldActions: 0 };
      const level = computeTrustLevel(
        {
          current: r.trustLevel,
          daysVisited: r.daysVisited,
          posts: c.posts,
          reputation: r.reputation,
          upheldActions: c.upheldActions,
          accountAgeDays: Math.floor(
            (now.getTime() - r.createdAt.getTime()) / DAY_MS,
          ),
        },
        thresholds,
      );
      return level === r.trustLevel
        ? []
        : [{ userId: r.userId, from: r.trustLevel, to: level }];
    });
    if (moves.length > 0) {
      changed += await db.transaction(async (tx) => {
        const t = tx as unknown as Db;
        let done = 0;
        for (const m of moves) {
          // Still at the level read and still unlocked: a moderator who
          // locked it meanwhile wins.
          const updated = await t
            .update(profiles)
            .set({ trustLevel: m.to, updatedAt: now })
            .where(
              and(
                eq(profiles.userId, m.userId),
                eq(profiles.trustLevel, m.from),
                eq(profiles.trustLevelLocked, false),
              ),
            )
            .returning({ userId: profiles.userId });
          if (updated.length === 0) continue;
          await t.insert(trustLevelChanges).values({
            id: newId(),
            userId: m.userId,
            fromLevel: m.from,
            toLevel: m.to,
            source: "auto",
            changedBy: null,
            reason: null,
            changedAt: now,
          });
          done++;
        }
        return done;
      });
    }
    if (rows.length < batch) break;
  }
  return { changed };
}

/** The staff member acting; `userId` is the user row behind them. */
export interface TrustActor {
  kind: "admin" | "moderator";
  label: string;
  userId: string;
  requestId?: string;
}

function auditFor(actor: TrustActor, reason: string) {
  return {
    actorUserId: actor.userId,
    actorKind: actor.kind,
    actorLabel: actor.label,
    reason,
    requestId: actor.requestId ?? null,
  };
}

async function lockProfile(tx: Db, userId: string) {
  const [row] = await tx
    .select({
      trustLevel: profiles.trustLevel,
      trustLevelLocked: profiles.trustLevelLocked,
    })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .for("update");
  if (!row) throw new IdentityError("no_such_user");
  return row;
}

/**
 * Fixes a user's level by hand and locks it, so the nightly job leaves it
 * until the lock is cleared. One transaction with the history row and the
 * audit row.
 */
export async function setTrustLevel(
  db: Db,
  now: Date,
  input: {
    userId: string;
    level: TrustLevel;
    reason: string;
    actor: TrustActor;
  },
): Promise<void> {
  const reason = requireReason(input.reason);
  if (![0, 1, 2, 3].includes(input.level)) {
    throw new IdentityError("invalid_trust_level");
  }
  await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const before = await lockProfile(t, input.userId);
    await t
      .update(profiles)
      .set({ trustLevel: input.level, trustLevelLocked: true, updatedAt: now })
      .where(eq(profiles.userId, input.userId));
    await t.insert(trustLevelChanges).values({
      id: newId(),
      userId: input.userId,
      fromLevel: before.trustLevel,
      toLevel: input.level,
      source: "moderator",
      changedBy: input.actor.userId,
      reason,
      changedAt: now,
    });
    await writeAudit(t, now, {
      ...auditFor(input.actor, reason),
      action: "user.trust_level.set",
      entityType: "user",
      entityId: input.userId,
      before: {
        trustLevel: before.trustLevel,
        trustLevelLocked: before.trustLevelLocked,
      },
      after: { trustLevel: input.level, trustLevelLocked: true },
    });
  });
}

/** Hands the level back to the nightly job. The level itself is unchanged. */
export async function clearTrustLock(
  db: Db,
  now: Date,
  input: { userId: string; reason: string; actor: TrustActor },
): Promise<void> {
  const reason = requireReason(input.reason);
  await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const before = await lockProfile(t, input.userId);
    if (!before.trustLevelLocked) return;
    await t
      .update(profiles)
      .set({ trustLevelLocked: false, updatedAt: now })
      .where(eq(profiles.userId, input.userId));
    await writeAudit(t, now, {
      ...auditFor(input.actor, reason),
      action: "user.trust_level.unlock",
      entityType: "user",
      entityId: input.userId,
      before: { trustLevelLocked: true },
      after: { trustLevelLocked: false },
    });
  });
}
