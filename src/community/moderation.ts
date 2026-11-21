/**
 * Reports and the moderation queue (DM 5.8, 5.9; HLD §7.4). Reports about
 * the same thing group into one open queue item and add their weight; when
 * the weight reaches the threshold the content hides pending review. A
 * filter hit opens an item too. Each item keeps a snapshot of the content as
 * it was first queued, with later edits appended, so the evidence survives
 * edits, deletes and the chat archive.
 *
 * Task 12 adds the other half: resolving items, the actions and the log.
 */
import { and, eq, or, sql } from "drizzle-orm";
import {
  chatMessages,
  modQueueItems,
  posts,
  reports,
  threads,
  type PostStatus,
  type QueueSource,
  type ReportReason,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { SYSTEM_USER_ID } from "@/identity/system";
import type { Viewer } from "@/identity/viewer";
import { newId } from "@/lib/ids";
import { getSetting } from "@/settings";
import { refuse, type CommunityRefusal } from "./errors";
import { effectiveLevel, type FilterHit } from "./gate";
import type { ReportableType } from "./report-values";

export { REPORTABLE_TYPES, type ReportableType } from "./report-values";

/** A logged-out reporter (DM 5.8): an address to answer, and a bot check. */
export type VisitorReporter = { contact: string; captchaToken: string };
export type Reporter = Viewer | VisitorReporter;

export type ReportInput = {
  targetType: ReportableType;
  targetId: string;
  reason: ReportReason;
  note?: string | null;
};

/** Checks a Turnstile token. The server passes Cloudflare's; tests pass a stub. */
export type CaptchaVerifier = (token: string) => Promise<boolean>;

export type ReportResult =
  | {
      ok: true;
      queueItemId: string;
      /** The item's weight has reached the threshold: the content is hidden. */
      hidden: boolean;
    }
  | CommunityRefusal;

/** What was posted, as the queue keeps it. */
export type ContentSnapshot = {
  threadId: string;
  /** For a thread. */
  title?: string;
  body: string;
  postedAt: string;
  /** Each later edit's text, oldest first. */
  edits: { body: string; at: string }[];
};

/** A post an author or reader can still see, so it can be reported. */
const REPORTABLE_POST: PostStatus[] = [
  "visible",
  "pending_review",
  "hidden_by_flags",
];

type Target = {
  type: ReportableType;
  id: string;
  authorUserId: string | null;
  snapshot: ContentSnapshot;
  /** The post that hides for a post or a thread; null for chat. */
  postId: string | null;
};

const isVisitor = (r: Reporter): r is VisitorReporter =>
  "captchaToken" in r && !("userId" in r);

async function loadTarget(
  db: Db,
  type: ReportableType,
  id: string,
): Promise<Target | null> {
  if (type === "chat_message") {
    const [row] = await db
      .select({
        threadId: chatMessages.threadId,
        authorUserId: chatMessages.authorUserId,
        body: chatMessages.body,
        status: chatMessages.status,
        createdAt: chatMessages.createdAt,
      })
      .from(chatMessages)
      .where(eq(chatMessages.id, id));
    if (!row || row.status !== "visible") return null;
    return {
      type,
      id,
      authorUserId: row.authorUserId,
      postId: null,
      snapshot: {
        threadId: row.threadId,
        body: row.body,
        postedAt: row.createdAt.toISOString(),
        edits: [],
      },
    };
  }
  const [row] = await db
    .select({
      postId: posts.id,
      threadId: posts.threadId,
      authorUserId: posts.authorUserId,
      body: posts.body,
      status: posts.status,
      createdAt: posts.createdAt,
      title: threads.title,
      threadStatus: threads.status,
    })
    .from(posts)
    .innerJoin(threads, eq(threads.id, posts.threadId))
    .where(
      type === "thread"
        ? and(eq(posts.threadId, id), eq(posts.isOpening, true))
        : eq(posts.id, id),
    );
  if (!row || !REPORTABLE_POST.includes(row.status)) return null;
  if (row.threadStatus === "removed") return null;
  return {
    type,
    id,
    authorUserId: row.authorUserId,
    postId: row.postId,
    snapshot: {
      threadId: row.threadId,
      ...(type === "thread" ? { title: row.title } : {}),
      body: row.body,
      postedAt: row.createdAt.toISOString(),
      edits: [],
    },
  };
}

/**
 * The open item for a target, opened if there is none. The unique open index
 * settles two openings at once: the loser reads the winner's row.
 */
async function openItem(
  db: Db,
  now: Date,
  target: Omit<Target, "postId">,
  source: QueueSource,
  hits: FilterHit[] = [],
) {
  const inserted = await db
    .insert(modQueueItems)
    .values({
      id: newId(),
      targetType: target.type,
      targetId: target.id,
      targetUserId: target.authorUserId,
      source,
      contentSnapshot: target.snapshot,
      filterHits: hits.length > 0 ? hits : null,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: modQueueItems.id });
  const [item] = await db
    .select({
      id: modQueueItems.id,
      weightSum: modQueueItems.weightSum,
      filterHits: modQueueItems.filterHits,
    })
    .from(modQueueItems)
    .where(
      and(
        eq(modQueueItems.targetType, target.type),
        eq(modQueueItems.targetId, target.id),
        eq(modQueueItems.status, "open"),
      ),
    );
  if (!item) throw new Error("openItem: no open item after insert");
  if (inserted.length === 0 && hits.length > 0) {
    // Already open: add these hits to the ones it has.
    const had = (item.filterHits as FilterHit[] | null) ?? [];
    await db
      .update(modQueueItems)
      .set({ filterHits: [...had, ...hits] })
      .where(eq(modQueueItems.id, item.id));
  }
  return item;
}

/** Hides the content; true when it was showing until now. */
async function hide(db: Db, target: Target): Promise<boolean> {
  if (target.postId === null) {
    const changed = await db
      .update(chatMessages)
      .set({ status: "removed" })
      .where(
        and(eq(chatMessages.id, target.id), eq(chatMessages.status, "visible")),
      )
      .returning({ id: chatMessages.id });
    return changed.length > 0;
  }
  const [changed] = await db
    .update(posts)
    .set({ status: "hidden_by_flags" })
    .where(and(eq(posts.id, target.postId), eq(posts.status, "visible")))
    .returning({ isOpening: posts.isOpening, threadId: posts.threadId });
  if (!changed) return false;
  if (!changed.isOpening) {
    await db
      .update(threads)
      .set({ replyCount: sql`greatest(${threads.replyCount} - 1, 0)` })
      .where(eq(threads.id, changed.threadId));
  }
  return true;
}

class AlreadyReported extends Error {}

/**
 * Files a report (DM 5.8). One per person per target: a second changes
 * nothing. A logged-out report needs a contact address and a passing bot
 * check, and weighs `report_weights.visitor` (0 by default: queued, never
 * auto-hidden).
 */
export async function report(
  db: Db,
  now: Date,
  reporter: Reporter,
  input: ReportInput,
  { verifyCaptcha }: { verifyCaptcha: CaptchaVerifier },
): Promise<ReportResult> {
  const weights = await getSetting(db, "report_weights");
  let reporterUserId: string | null = null;
  let contact: string | null = null;
  let weight: number;
  if (isVisitor(reporter)) {
    contact = reporter.contact.trim();
    if (!reporter.captchaToken || !(await verifyCaptcha(reporter.captchaToken)))
      return refuse("captcha_failed");
    if (contact.length === 0) return refuse("forbidden");
    weight = weights.visitor;
  } else {
    reporterUserId = reporter.userId;
    const level = effectiveLevel(reporter, reporter.profile.trustLevel);
    weight = level >= 3 ? weights.tl3 : weights[`tl${level as 0 | 1 | 2}`];
  }

  const target = await loadTarget(db, input.targetType, input.targetId);
  if (!target) return refuse("not_found");
  if (reporterUserId !== null && reporterUserId === target.authorUserId)
    return refuse("forbidden");

  const current = async (): Promise<ReportResult> => {
    const [row] = await db
      .select({
        queueItemId: reports.queueItemId,
        weightSum: modQueueItems.weightSum,
      })
      .from(reports)
      .innerJoin(modQueueItems, eq(modQueueItems.id, reports.queueItemId))
      .where(
        and(
          eq(reports.targetType, input.targetType),
          eq(reports.targetId, input.targetId),
          eq(reports.reporterUserId, reporterUserId!),
        ),
      );
    if (!row) throw new Error("report: the earlier report is gone");
    return {
      ok: true,
      queueItemId: row.queueItemId,
      hidden:
        target.authorUserId !== SYSTEM_USER_ID &&
        row.weightSum >= weights.threshold,
    };
  };

  if (reporterUserId !== null) {
    const [earlier] = await db
      .select({ id: reports.id })
      .from(reports)
      .where(
        and(
          eq(reports.targetType, input.targetType),
          eq(reports.targetId, input.targetId),
          eq(reports.reporterUserId, reporterUserId),
        ),
      );
    if (earlier) return current();
  }

  try {
    return await db.transaction(async (tx): Promise<ReportResult> => {
      const t = tx as unknown as Db;
      const item = await openItem(t, now, target, "reports");
      const filed = await t
        .insert(reports)
        .values({
          id: newId(),
          queueItemId: item.id,
          targetType: input.targetType,
          targetId: input.targetId,
          reporterUserId,
          reporterContact: contact,
          reason: input.reason,
          note: input.note?.trim() || null,
          weight,
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: reports.id });
      // Two reports from one person at once: the second rolls back.
      if (filed.length === 0) throw new AlreadyReported();
      const [updated] = await t
        .update(modQueueItems)
        .set({
          reportCount: sql`${modQueueItems.reportCount} + 1`,
          weightSum: sql`${modQueueItems.weightSum} + ${weight}`,
          version: sql`${modQueueItems.version} + 1`,
        })
        .where(eq(modQueueItems.id, item.id))
        .returning({ weightSum: modQueueItems.weightSum });
      // The system account's posts (results, session threads) only queue:
      // reports can't take them down.
      const hidden =
        target.authorUserId !== SYSTEM_USER_ID &&
        updated!.weightSum >= weights.threshold;
      if (hidden && (await hide(t, target))) {
        await t
          .update(modQueueItems)
          .set({ source: "auto_hide" })
          .where(eq(modQueueItems.id, item.id));
      }
      return { ok: true, queueItemId: item.id, hidden };
    });
  } catch (error) {
    if (error instanceof AlreadyReported) return current();
    throw error;
  }
}

/**
 * A filter hold or flag at posting (DM 5.9 step 7): opens the target's item,
 * or adds the hits to the one already open. Runs inside the post's
 * transaction.
 */
export async function queueFilterHits(
  db: Db,
  now: Date,
  target: {
    type: ReportableType;
    id: string;
    authorUserId: string;
    threadId: string;
    title?: string;
    body: string;
  },
  hits: FilterHit[],
): Promise<void> {
  if (hits.length === 0) return;
  await openItem(
    db,
    now,
    {
      type: target.type,
      id: target.id,
      authorUserId: target.authorUserId,
      snapshot: {
        threadId: target.threadId,
        ...(target.title !== undefined ? { title: target.title } : {}),
        body: target.body,
        postedAt: now.toISOString(),
        edits: [],
      },
    },
    "filter",
    hits,
  );
}

/**
 * An author's edit to a queued post: the new text joins the open items'
 * snapshots, after the text they first kept. An opening post's edit counts
 * for its thread's item too.
 */
export async function noteEdit(
  db: Db,
  now: Date,
  post: { postId: string; threadId: string; isOpening: boolean; body: string },
): Promise<void> {
  const targets = or(
    and(
      eq(modQueueItems.targetType, "post"),
      eq(modQueueItems.targetId, post.postId),
    ),
    post.isOpening
      ? and(
          eq(modQueueItems.targetType, "thread"),
          eq(modQueueItems.targetId, post.threadId),
        )
      : sql`false`,
  );
  const edit = { body: post.body, at: now.toISOString() };
  await db
    .update(modQueueItems)
    .set({
      contentSnapshot: sql`jsonb_set(${modQueueItems.contentSnapshot}, '{edits}', coalesce(${modQueueItems.contentSnapshot} -> 'edits', '[]'::jsonb) || jsonb_build_array(${JSON.stringify(edit)}::jsonb))`,
    })
    .where(and(eq(modQueueItems.status, "open"), targets));
}
