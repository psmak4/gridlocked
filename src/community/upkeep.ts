/**
 * The forum's daily upkeep (M7 Task 15), run by `community_daily`:
 * - reputation from votes cast by TL1 and up (and staff) only (DM 5.6);
 * - the trust job's forum counts: visible posts and upheld actions;
 * - hot rank, a sweep behind the write that keeps it (a vote, a new thread);
 * - retention (DM 5.10): revisions after a year, notifications and
 *   broadcasts after 90 days, resolved reports, their queue items and
 *   moderation actions after two years.
 */
import {
  and,
  count,
  eq,
  gt,
  inArray,
  isNotNull,
  lt,
  ne,
  sql,
  type SQL,
} from "drizzle-orm";
import {
  broadcasts,
  modActions,
  modQueueItems,
  notifications,
  postRevisions,
  posts,
  reports,
  threads,
} from "@/db/schema";
import type { Db } from "@/db/types";
import type { TrustCounts } from "@/identity/trust";

const DAY_MS = 86_400_000;

/**
 * Hot rank's zero point. The formula is time-invariant, so it only needs to
 * be counted from somewhere near: a `real` keeps about seven digits.
 */
const HOT_EPOCH_SECONDS = Date.UTC(2026, 0, 1) / 1000;
/** Seconds that weigh as much as ten times the score. */
const HOT_DECAY_SECONDS = 45_000;

/** `log10(max(|score|, 1)) × sign(score) + created_at_seconds / 45000`. */
export function hotRank(score: number, createdAt: Date): number {
  return (
    Math.log10(Math.max(Math.abs(score), 1)) * Math.sign(score) +
    (createdAt.getTime() / 1000 - HOT_EPOCH_SECONDS) / HOT_DECAY_SECONDS
  );
}

/** The same, in SQL, for a score and a creation time. */
export function hotRankSql(score: SQL | unknown, createdAt: unknown): SQL {
  return sql`log(greatest(abs(${score}), 1)) * sign(${score}) + (extract(epoch from ${createdAt}) - ${HOT_EPOCH_SECONDS}) / ${HOT_DECAY_SECONDS}`;
}

/**
 * Hot rank again for threads active in the last 48 hours: the vote keeps it,
 * this catches anything that missed. Returns the threads changed.
 */
export async function refreshHotRank(db: Db, now: Date): Promise<number> {
  const since = new Date(now.getTime() - 2 * DAY_MS);
  const fresh = hotRankSql(threads.score, threads.createdAt);
  const changed = await db
    .update(threads)
    .set({ hotRank: fresh })
    .where(
      and(
        gt(threads.lastActivityAt, since),
        sql`abs(${threads.hotRank} - (${fresh})) > 0.0001`,
      ),
    )
    .returning({ id: threads.id });
  return changed.length;
}

/**
 * Each profile's reputation: the votes on their visible posts, counting only
 * voters at TL1 and up or staff, and never their own. Returns the profiles
 * changed.
 */
export async function recomputeReputation(db: Db): Promise<number> {
  const result = await db.execute(sql`
    with earned as (
      select p.author_user_id as user_id, sum(v.value)::int as total
      from post_votes v
      join posts p on p.id = v.post_id
      join profiles voter on voter.user_id = v.user_id
      join users vu on vu.id = v.user_id
      where p.status = 'visible'
        and p.author_user_id is not null
        and v.user_id <> p.author_user_id
        and (voter.trust_level >= 1 or vu.role in ('admin', 'moderator'))
      group by p.author_user_id
    )
    update profiles
    set reputation = coalesce(earned.total, 0)
    from profiles target
    left join earned on earned.user_id = target.user_id
    where profiles.user_id = target.user_id
      and target.status <> 'deleted'
      and profiles.reputation <> coalesce(earned.total, 0)
    returning profiles.user_id
  `);
  return (result as unknown as { rows: unknown[] }).rows.length;
}

/** Moderation actions that count against someone's trust (DM 5.9). */
const UPHELD = ["remove", "warn", "mute", "chat_ban"] as const;

/** The trust job's forum numbers: visible posts and upheld actions. */
export const forumTrustCounts: TrustCounts = async (db, userIds) => {
  const counts = new Map(
    userIds.map((id) => [id, { posts: 0, upheldActions: 0 }]),
  );
  if (userIds.length === 0) return counts;
  const written = await db
    .select({ userId: posts.authorUserId, n: count() })
    .from(posts)
    .where(
      and(inArray(posts.authorUserId, userIds), eq(posts.status, "visible")),
    )
    .groupBy(posts.authorUserId);
  for (const row of written) {
    if (row.userId) counts.get(row.userId)!.posts = Number(row.n);
  }
  const acted = await db
    .select({ userId: modActions.targetUserId, n: count() })
    .from(modActions)
    .where(
      and(
        inArray(modActions.targetUserId, userIds),
        inArray(modActions.action, [...UPHELD]),
      ),
    )
    .groupBy(modActions.targetUserId);
  for (const row of acted) {
    if (row.userId) counts.get(row.userId)!.upheldActions = Number(row.n);
  }
  return counts;
};

export type PruneCounts = {
  revisions: number;
  notifications: number;
  broadcasts: number;
  reports: number;
  queueItems: number;
  modActions: number;
};

/** DM 5.10's retention. Safe to run again. */
export async function pruneCommunity(db: Db, now: Date): Promise<PruneCounts> {
  const ago = (days: number) => new Date(now.getTime() - days * DAY_MS);
  const year = ago(365);
  const ninety = ago(90);
  const twoYears = ago(730);

  const revisions = await db
    .delete(postRevisions)
    .where(sql`${postRevisions.editedAt} <= ${year}`)
    .returning({ id: postRevisions.id });
  const oldNotifications = await db
    .delete(notifications)
    .where(lt(notifications.createdAt, ninety))
    .returning({ id: notifications.id });
  const oldBroadcasts = await db
    .delete(broadcasts)
    .where(lt(broadcasts.createdAt, ninety))
    .returning({ id: broadcasts.id });

  const actions = await db
    .delete(modActions)
    .where(lt(modActions.createdAt, twoYears))
    .returning({ id: modActions.id });
  const decided = db
    .select({ id: modQueueItems.id })
    .from(modQueueItems)
    .where(
      and(
        ne(modQueueItems.status, "open"),
        isNotNull(modQueueItems.resolvedAt),
        lt(modQueueItems.resolvedAt, twoYears),
      ),
    );
  const oldReports = await db
    .delete(reports)
    .where(inArray(reports.queueItemId, decided))
    .returning({ id: reports.id });
  // An item a kept action still points at stays with it.
  const items = await db
    .delete(modQueueItems)
    .where(
      and(
        ne(modQueueItems.status, "open"),
        isNotNull(modQueueItems.resolvedAt),
        lt(modQueueItems.resolvedAt, twoYears),
        sql`not exists (select 1 from ${modActions} where ${modActions.queueItemId} = ${modQueueItems.id})`,
        sql`not exists (select 1 from ${reports} where ${reports.queueItemId} = ${modQueueItems.id})`,
      ),
    )
    .returning({ id: modQueueItems.id });

  return {
    revisions: revisions.length,
    notifications: oldNotifications.length,
    broadcasts: oldBroadcasts.length,
    reports: oldReports.length,
    queueItems: items.length,
    modActions: actions.length,
  };
}
