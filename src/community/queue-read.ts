/**
 * The moderation queue's reads (M8 Task 11, wave 5's moderation board): the
 * Open, Auto-hidden and Done tabs, and one item with what was posted as it
 * was at the first report, the reports by reason, and the author's history.
 * Which two actions an item offers, besides "Keep it, close reports", is the
 * table below, by what it is and what it was reported for. The actions
 * themselves are `moderate`'s.
 */
import { and, count, desc, eq, inArray, lt, ne, or, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  chatMessages,
  modActions,
  modQueueItems,
  posts,
  profiles,
  reports,
  threads,
  users,
  type QueueStatus,
  type ReportReason,
  type ReportTargetType,
} from "@/db/schema";
import type { Db } from "@/db/types";
import type { M7ModAction } from "./moderate";
import type { ContentSnapshot } from "./moderation";
import { DELETED_USER } from "./read";
import { REPORT_REASONS } from "./report-values";

export type ModTab = "open" | "hidden" | "done";
export type ModState = "Open" | "Auto-hidden" | "Actioned" | "Dismissed";

export type ModListItem = {
  id: string;
  targetId: string;
  type: ReportTargetType;
  state: ModState;
  /** The most-reported reason, or `filter` for an item the filter raised. */
  reason: ReportReason | "filter";
  snippet: string;
  /** The thread it's in. */
  where: string;
  reports: number;
  createdAt: Date;
};

/** One of an item's actions: on the content, or on its author. */
export type QueueAction = {
  action: M7ModAction;
  label: string;
  on: "content" | "author";
  /** For a mute: how long, in hours. */
  hours?: number;
  /** `retitle` needs the new spoiler-safe title. */
  needsTitle?: true;
};

export type ModItem = ModListItem & {
  status: QueueStatus;
  version: number;
  snapshot: ContentSnapshot;
  /** The reports by reason, most first. */
  byReason: { reason: ReportReason; count: number }[];
  /** What reporters wrote, newest first. */
  notes: string[];
  author: {
    userId: string | null;
    username: string;
    trustLevel: number | null;
    /** "Mar 2026". */
    joined: string;
    posts: number;
    /** Actions taken against them before, from `mod_actions`. */
    earlier: number;
  };
  actions: QueueAction[];
  resolution: string | null;
  resolvedAt: Date | null;
};

/** What the queue can act on as content, rather than only on its author. */
const CONTENT = new Set<ReportTargetType>(["post", "thread", "chat_message"]);

/** A page of the Done tab. */
const DONE_PAGE = 50;
const SNIPPET = 140;

const snapshotSchema = z.object({
  threadId: z.string(),
  title: z.string().optional(),
  body: z.string(),
  postedAt: z.string(),
  edits: z.array(z.object({ body: z.string(), at: z.string() })).default([]),
});

const KEEP: QueueAction = {
  action: "restore",
  label: "Keep it, close reports",
  on: "content",
};
const WARN: QueueAction = {
  action: "warn",
  label: "Warn the author",
  on: "author",
};
const MUTE_WEEK: QueueAction = {
  action: "mute",
  label: "Mute the author for 7 days",
  on: "author",
  hours: 24 * 7,
};
const MUTE_DAY: QueueAction = {
  action: "mute",
  label: "Mute the author for 24 hours",
  on: "author",
  hours: 24,
};

/**
 * The two actions that fit an item, by what it is and why it was reported.
 * A spoiler thread is retitled rather than removed first; spam gets its
 * author muted; anything else, a warning.
 */
export function actionsFor(
  type: ReportTargetType,
  reason: ReportReason | "filter",
): QueueAction[] {
  switch (type) {
    case "thread": {
      const remove: QueueAction = {
        action: "remove",
        label: "Remove thread",
        on: "content",
      };
      if (reason === "spoiler") {
        return [
          {
            action: "retitle",
            label: "Retitle and mark as spoiler",
            on: "content",
            needsTitle: true,
          },
          remove,
        ];
      }
      if (reason === "spam") return [remove, MUTE_WEEK];
      return [{ action: "lock", label: "Lock thread", on: "content" }, remove];
    }
    case "chat_message": {
      const remove: QueueAction = {
        action: "remove",
        label: "Remove message",
        on: "content",
      };
      return [remove, reason === "spam" ? MUTE_DAY : WARN];
    }
    case "post": {
      const remove: QueueAction = {
        action: "remove",
        label: "Remove post",
        on: "content",
      };
      return [remove, reason === "spam" ? MUTE_WEEK : WARN];
    }
    default:
      return [WARN, MUTE_WEEK];
  }
}

type Row = typeof modQueueItems.$inferSelect;

/** Whether each item's content is hidden by flags right now. */
async function hiddenByFlags(db: Db, items: Row[]): Promise<Set<string>> {
  const postIds = items
    .filter((i) => i.targetType === "post")
    .map((i) => i.targetId);
  const threadIds = items
    .filter((i) => i.targetType === "thread")
    .map((i) => i.targetId);
  const hidden = new Set<string>();
  if (postIds.length > 0) {
    for (const p of await db
      .select({ id: posts.id })
      .from(posts)
      .where(
        and(inArray(posts.id, postIds), eq(posts.status, "hidden_by_flags")),
      )) {
      hidden.add(p.id);
    }
  }
  if (threadIds.length > 0) {
    for (const p of await db
      .select({ threadId: posts.threadId })
      .from(posts)
      .where(
        and(
          inArray(posts.threadId, threadIds),
          eq(posts.isOpening, true),
          eq(posts.status, "hidden_by_flags"),
        ),
      )) {
      hidden.add(p.threadId);
    }
  }
  return hidden;
}

async function topReasons(
  db: Db,
  ids: string[],
): Promise<Map<string, { reason: ReportReason; count: number }[]>> {
  const byItem = new Map<string, { reason: ReportReason; count: number }[]>();
  if (ids.length === 0) return byItem;
  const rows = await db
    .select({
      queueItemId: reports.queueItemId,
      reason: reports.reason,
      count: count(),
    })
    .from(reports)
    .where(inArray(reports.queueItemId, ids))
    .groupBy(reports.queueItemId, reports.reason);
  for (const row of rows) {
    byItem.set(row.queueItemId, [
      ...(byItem.get(row.queueItemId) ?? []),
      { reason: row.reason, count: row.count },
    ]);
  }
  for (const list of byItem.values()) {
    list.sort(
      (a, b) =>
        b.count - a.count ||
        REPORT_REASONS.indexOf(a.reason) - REPORT_REASONS.indexOf(b.reason),
    );
  }
  return byItem;
}

async function threadTitles(
  db: Db,
  ids: string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  return new Map(
    (
      await db
        .select({ id: threads.id, title: threads.title })
        .from(threads)
        .where(inArray(threads.id, ids))
    ).map((t) => [t.id, t.title]),
  );
}

function stateOf(item: Row, hidden: Set<string>): ModState {
  if (item.status === "actioned") return "Actioned";
  if (item.status === "dismissed") return "Dismissed";
  return hidden.has(item.targetId) ? "Auto-hidden" : "Open";
}

async function listItems(db: Db, items: Row[]): Promise<ModListItem[]> {
  const hidden = await hiddenByFlags(db, items);
  const reasons = await topReasons(
    db,
    items.map((i) => i.id),
  );
  const snapshots = new Map(
    items.map((i) => [i.id, snapshotSchema.parse(i.contentSnapshot)]),
  );
  const titles = await threadTitles(db, [
    ...new Set([...snapshots.values()].map((s) => s.threadId)),
  ]);
  return items.map((item) => {
    const snapshot = snapshots.get(item.id)!;
    const text = snapshot.title ?? snapshot.body;
    return {
      id: item.id,
      targetId: item.targetId,
      type: item.targetType,
      state: stateOf(item, hidden),
      reason: reasons.get(item.id)?.[0]?.reason ?? "filter",
      snippet: text.length > SNIPPET ? `${text.slice(0, SNIPPET - 1)}…` : text,
      where: titles.get(snapshot.threadId) ?? "",
      reports: item.reportCount,
      createdAt: item.createdAt,
    };
  });
}

/**
 * A tab of the queue: Open (every open item) and Auto-hidden (open items
 * whose content is hidden by flags), newest first; Done (actioned and
 * dismissed), newest decided first, 50 a page before the item `before`.
 */
export async function modQueue(
  db: Db,
  { tab, before }: { tab: ModTab; before?: string },
): Promise<ModListItem[]> {
  if (tab === "done") {
    const items = await db
      .select()
      .from(modQueueItems)
      .where(
        and(
          ne(modQueueItems.status, "open"),
          before ? lt(modQueueItems.id, before) : undefined,
        ),
      )
      .orderBy(desc(modQueueItems.id))
      .limit(DONE_PAGE);
    return listItems(db, items);
  }
  const items = await db
    .select()
    .from(modQueueItems)
    .where(eq(modQueueItems.status, "open"))
    .orderBy(desc(modQueueItems.createdAt), desc(modQueueItems.id));
  const list = await listItems(db, items);
  return tab === "hidden"
    ? list.filter((i) => i.state === "Auto-hidden")
    : list;
}

/** How many items are open, for the staff area's badge: a count, not the list. */
export async function openModCount(db: Db): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(modQueueItems)
    .where(eq(modQueueItems.status, "open"));
  return row?.n ?? 0;
}

const MONTH_YEAR = new Intl.DateTimeFormat("en-GB", {
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** One item with its snapshot, reports, author and actions; null if none. */
export async function modItem(db: Db, id: string): Promise<ModItem | null> {
  const [item] = await db
    .select()
    .from(modQueueItems)
    .where(eq(modQueueItems.id, id));
  if (!item) return null;
  const [listed] = await listItems(db, [item]);
  const reasons = (await topReasons(db, [id])).get(id) ?? [];
  const notes = (
    await db
      .select({ note: reports.note })
      .from(reports)
      .where(eq(reports.queueItemId, id))
      .orderBy(desc(reports.createdAt))
  ).flatMap((r) => (r.note ? [r.note] : []));

  let author: ModItem["author"] = {
    userId: null,
    username: DELETED_USER,
    trustLevel: null,
    joined: "",
    posts: 0,
    earlier: 0,
  };
  if (item.targetUserId) {
    const [who] = await db
      .select({
        username: users.username,
        displayUsername: users.displayUsername,
        createdAt: users.createdAt,
        trustLevel: profiles.trustLevel,
        status: profiles.status,
      })
      .from(users)
      .leftJoin(profiles, eq(profiles.userId, users.id))
      .where(eq(users.id, item.targetUserId));
    const [written] = await db
      .select({ n: count() })
      .from(posts)
      .where(eq(posts.authorUserId, item.targetUserId));
    const [chats] = await db
      .select({ n: count() })
      .from(chatMessages)
      .where(eq(chatMessages.authorUserId, item.targetUserId));
    const [earlier] = await db
      .select({ n: count() })
      .from(modActions)
      .where(
        and(
          eq(modActions.targetUserId, item.targetUserId),
          or(isNull(modActions.queueItemId), ne(modActions.queueItemId, id)),
        ),
      );
    const deleted = !who || who.status === "deleted";
    author = {
      userId: item.targetUserId,
      username: deleted
        ? DELETED_USER
        : (who.displayUsername ?? who.username ?? DELETED_USER),
      trustLevel: deleted ? null : (who.trustLevel ?? 0),
      joined: who ? MONTH_YEAR.format(who.createdAt) : "",
      posts: (written?.n ?? 0) + (chats?.n ?? 0),
      earlier: earlier?.n ?? 0,
    };
  }

  return {
    ...listed!,
    status: item.status,
    version: item.version,
    snapshot: snapshotSchema.parse(item.contentSnapshot),
    byReason: reasons,
    notes,
    author,
    // "Keep it" restores content; an item about a user or a name (nothing
    // files those yet) has only its author actions.
    actions: CONTENT.has(item.targetType)
      ? [...actionsFor(item.targetType, listed!.reason), KEEP]
      : actionsFor(item.targetType, listed!.reason),
    resolution: item.resolution,
    resolvedAt: item.resolvedAt,
  };
}
