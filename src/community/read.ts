/**
 * The forum's read models (M7 Task 6): the category list, a category's
 * threads and a thread's page. Every one is spoiler-safe by default: a
 * thread marked as containing spoilers shows its safe title and no posts
 * until the reader has revealed its session (HLD §7.3, DM 5.7).
 */
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import {
  categories,
  events,
  posts,
  postVotes,
  profiles,
  sessions,
  threads,
  users,
  type CategoryKind,
  type ThreadKind,
  type ThreadStatus,
} from "@/db/schema";
import type { Db } from "@/db/types";
import type { SessionKind } from "@/reference/calendar-types";
import type { Viewer } from "@/identity/viewer";
import { SESSION_LABELS, readerOf } from "@/play/weekend";
import {
  SPOILER_WINDOW_DAYS,
  isRevealed,
  revealedSessions,
  type Reader,
} from "@/spoilers/reveal";
import { renderPost } from "./render";
import { awaitingResultsSql, shortEvent, threadMode } from "./session-threads";
import { SPOILER_THREAD_TITLE } from "./threads";

/** How a deleted account's name reads anywhere it wrote (DM 5.1). */
export const DELETED_USER = "deleted user";

/** Replies below this depth sit behind "Continue thread" (DM 5.4). */
export const MAX_REPLY_DEPTH = 3;

/** Threads on one page of a category. */
export const THREADS_PER_PAGE = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export type CategoryView = {
  id: string;
  slug: string;
  name: string;
  description: string;
  kind: CategoryKind;
  minTrustToStartThread: number;
  /** Visible posts in the last 24 hours. */
  today: number;
};

/** The forum's front page: the active categories in their order. */
export async function categoryList(db: Db, now: Date): Promise<CategoryView[]> {
  const since = new Date(now.getTime() - DAY_MS);
  const rows = await db
    .select({
      id: categories.id,
      slug: categories.slug,
      name: categories.name,
      description: categories.description,
      kind: categories.kind,
      minTrustToStartThread: categories.minTrustToStartThread,
      today: sql<number>`count(${posts.id})::int`,
    })
    .from(categories)
    .leftJoin(
      threads,
      and(
        eq(threads.categoryId, categories.id),
        ne(threads.status, "removed"),
        isNull(threads.leagueId),
      ),
    )
    .leftJoin(
      posts,
      and(
        eq(posts.threadId, threads.id),
        eq(posts.status, "visible"),
        gt(posts.createdAt, since),
      ),
    )
    .where(eq(categories.status, "active"))
    .groupBy(categories.id)
    .orderBy(asc(categories.position));
  return rows;
}

// --- Spoilers ------------------------------------------------------------------

/** "the race", "qualifying": how a session reads inside a sentence. */
export function sessionPhrase(kind: SessionKind): string {
  if (kind === "race") return "the race";
  if (kind === "sprint") return "the sprint";
  return SESSION_LABELS[kind].toLowerCase();
}

type SpoilerFacts = {
  id: string;
  containsSpoilers: boolean;
  sessionId: string | null;
  createdAt: Date;
};

/**
 * The threads `reader` can't see yet. A thread tied to a session follows
 * that session's reveal; one without a session (a Race Weekend title the
 * check caught) is hidden for the window from its own start. `show` holds
 * the session or thread ids revealed for this page only (`?show=`).
 */
async function hiddenThreads(
  db: Db,
  now: Date,
  reader: Reader,
  rows: SpoilerFacts[],
  show: readonly string[] = [],
  showAll = false,
): Promise<Set<string>> {
  if (showAll) return new Set();
  const shown = new Set(show);
  const spoilers = rows.filter(
    (r) =>
      r.containsSpoilers &&
      !shown.has(r.id) &&
      !(r.sessionId && shown.has(r.sessionId)),
  );
  const revealed = await revealedSessions(
    db,
    now,
    reader,
    spoilers.flatMap((r) => (r.sessionId ? [r.sessionId] : [])),
  );
  const protection = reader?.spoilerProtection ?? true;
  return new Set(
    spoilers
      .filter((r) =>
        r.sessionId
          ? !revealed.has(r.sessionId)
          : !isRevealed({
              sessionStart: r.createdAt,
              now,
              watched: false,
              protection,
            }),
      )
      .map((r) => r.id),
  );
}

type TitleFacts = {
  title: string;
  spoilerSafeTitle: string | null;
  sessionKind: SessionKind | null;
  eventName: string | null;
};

/** The title a hidden thread shows, and the line under it. */
function hiddenTitle(t: TitleFacts): { title: string; note: string } {
  const safe = t.spoilerSafeTitle ?? SPOILER_THREAD_TITLE;
  // A session thread's own safe title already names its session.
  const generic = safe === SPOILER_THREAD_TITLE;
  if (!t.sessionKind || !t.eventName) {
    return {
      title: safe,
      note: `Title hidden for ${SPOILER_WINDOW_DAYS} days`,
    };
  }
  const label = SESSION_LABELS[t.sessionKind].toLowerCase();
  return {
    title: generic ? `${safe} · ${shortEvent(t.eventName)} ${label}` : safe,
    note: `Title hidden until you’ve watched ${sessionPhrase(t.sessionKind)}`,
  };
}

// --- Authors -------------------------------------------------------------------

/** The name an author shows under, or null for the system account. */
function authorName(row: {
  authorUserId: string | null;
  username: string | null;
  displayUsername: string | null;
  profileStatus: string | null;
}): string | null {
  if (!row.authorUserId) return null;
  if (row.profileStatus === "deleted") return DELETED_USER;
  return row.displayUsername ?? row.username ?? DELETED_USER;
}

const authorColumns = {
  username: users.username,
  displayUsername: users.displayUsername,
  profileStatus: profiles.status,
};

// --- Threads -------------------------------------------------------------------

export type ThreadBadge = "pinned" | "session" | "spoiler";

export type ThreadRow = {
  id: string;
  kind: ThreadKind;
  title: string;
  hidden: boolean;
  /** Under a hidden title: what it waits for. */
  hiddenNote: string | null;
  badge: ThreadBadge | null;
  author: string | null;
  replyCount: number;
  score: number;
  status: ThreadStatus;
  lastActivityAt: string;
};

export type ThreadSort = "hot" | "new";

export type ThreadListPage = {
  category: CategoryView | Omit<CategoryView, "today">;
  threads: ThreadRow[];
  /** The next page's cursor, or null on the last page. */
  nextCursor: string | null;
};

/** Threads anyone may see listed: not removed, not a league's own. */
const listable = (reader: Reader) =>
  and(
    inArray(threads.status, ["open", "locked", "archived"]),
    isNull(threads.leagueId),
    // A thread whose opening post is held, or hidden by reports, shows for
    // its author only. A deleted or removed opening post leaves the thread
    // and its replies, with a placeholder at the top (DM 5.4).
    or(
      sql`not exists (select 1 from ${posts} where ${posts.threadId} = ${threads.id} and ${posts.isOpening} and ${posts.status} in ('pending_review', 'hidden_by_flags'))`,
      reader ? eq(threads.authorUserId, reader.userId) : sql`false`,
    ),
  );

const threadColumns = {
  id: threads.id,
  kind: threads.kind,
  title: threads.title,
  spoilerSafeTitle: threads.spoilerSafeTitle,
  containsSpoilers: threads.containsSpoilers,
  sessionId: threads.sessionId,
  sessionKind: sessions.kind,
  eventName: events.name,
  authorUserId: threads.authorUserId,
  ...authorColumns,
  pinned: threads.pinned,
  replyCount: threads.replyCount,
  score: threads.score,
  status: threads.status,
  lastActivityAt: threads.lastActivityAt,
  createdAt: threads.createdAt,
};

type ThreadFacts = TitleFacts & {
  id: string;
  kind: ThreadKind;
  containsSpoilers: boolean;
  sessionId: string | null;
  authorUserId: string | null;
  username: string | null;
  displayUsername: string | null;
  profileStatus: string | null;
  pinned: boolean;
  replyCount: number;
  score: number;
  status: ThreadStatus;
  lastActivityAt: Date;
  createdAt: Date;
};

function toRow(t: ThreadFacts, hidden: boolean): ThreadRow {
  const veil = hidden ? hiddenTitle(t) : null;
  return {
    id: t.id,
    kind: t.kind,
    title: veil?.title ?? t.title,
    hidden,
    hiddenNote: veil?.note ?? null,
    badge: t.pinned
      ? "pinned"
      : t.containsSpoilers
        ? "spoiler"
        : t.kind === "session" || t.kind === "results"
          ? "session"
          : null,
    author: authorName(t),
    replyCount: t.replyCount,
    score: t.score,
    status: t.status,
    lastActivityAt: t.lastActivityAt.toISOString(),
  };
}

/** A category's threads: pinned first, then hot or new, a page at a time. */
export async function threadList(
  db: Db,
  now: Date,
  reader: Reader,
  input: {
    categorySlug: string;
    sort: ThreadSort;
    /** From the last page's `nextCursor`. */
    cursor?: string | null;
    show?: readonly string[];
    /** `?show=all`: nothing hidden on this page. */
    showAll?: boolean;
  },
): Promise<ThreadListPage | null> {
  const [category] = await db
    .select({
      id: categories.id,
      slug: categories.slug,
      name: categories.name,
      description: categories.description,
      kind: categories.kind,
      minTrustToStartThread: categories.minTrustToStartThread,
    })
    .from(categories)
    .where(
      and(
        eq(categories.slug, input.categorySlug),
        eq(categories.status, "active"),
      ),
    );
  if (!category) return null;

  const offset = Math.max(0, Number.parseInt(input.cursor ?? "0", 10) || 0);
  const order =
    input.sort === "hot"
      ? [desc(threads.hotRank), desc(threads.lastActivityAt)]
      : [desc(threads.lastActivityAt)];
  const rows = await db
    .select(threadColumns)
    .from(threads)
    .leftJoin(sessions, eq(sessions.id, threads.sessionId))
    .leftJoin(events, eq(events.id, sessions.eventId))
    .leftJoin(users, eq(users.id, threads.authorUserId))
    .leftJoin(profiles, eq(profiles.userId, threads.authorUserId))
    .where(and(eq(threads.categoryId, category.id), listable(reader)))
    .orderBy(desc(threads.pinned), ...order, desc(threads.id))
    .limit(THREADS_PER_PAGE + 1)
    .offset(offset);

  const page = rows.slice(0, THREADS_PER_PAGE);
  const hidden = await hiddenThreads(
    db,
    now,
    reader,
    page,
    input.show,
    input.showAll,
  );
  return {
    category,
    threads: page.map((t) => toRow(t, hidden.has(t.id))),
    nextCursor:
      rows.length > THREADS_PER_PAGE ? String(offset + THREADS_PER_PAGE) : null,
  };
}

// --- A thread's page ------------------------------------------------------------

export type PostState = "visible" | "pending" | "deleted" | "removed";

export type PostView = {
  id: string;
  parentId: string | null;
  /** On screen: the opening post is 0, and replies 1 to 3. */
  depth: number;
  isOpening: boolean;
  author: string | null;
  /** Rendered Markdown, or null for a "[deleted]" or "[removed]" placeholder. */
  html: string | null;
  state: PostState;
  score: number;
  myVote: -1 | 0 | 1;
  mine: boolean;
  /** Your own readable post's Markdown, for "Edit"; null on anyone else's. */
  source: string | null;
  createdAt: string;
  edited: boolean;
  /** Replies under it past the depth cap, behind "Continue thread". */
  moreReplies: number;
};

export type PostSort = "best" | "new";

export type ThreadMode = "chat" | "discussion";

export type ThreadPage = {
  thread: ThreadRow & {
    categorySlug: string;
    categoryName: string;
    sessionId: string | null;
    sessionLabel: string | null;
    /** "qualifying", "the race": for the cover's sentence. */
    sessionPhrase: string | null;
    eventName: string | null;
    createdAt: string;
  };
  /** Live chat while its window is open; discussion before and after. */
  mode: ThreadMode;
  /** When chat opens, while that's still ahead: the page reloads then. */
  opensChatAt: string | null;
  hidden: boolean;
  /**
   * When a shown page hides for this reader: its session's start, if that's
   * still ahead and the reader hasn't watched or shown it. The page reloads
   * then, so an open chat doesn't run on into the result (HLD §7.3).
   */
  hidesAt: string | null;
  /** Set when the page opens at one reply ("Continue thread"). */
  focusPostId: string | null;
  posts: PostView[];
};

type PostFacts = {
  id: string;
  parentPostId: string | null;
  depth: number;
  isOpening: boolean;
  authorUserId: string;
  username: string | null;
  displayUsername: string | null;
  profileStatus: string | null;
  trustLevel: number | null;
  body: string;
  status: string;
  score: number;
  createdAt: Date;
  editedAt: Date | null;
};

const STATE_OF: Record<string, PostState> = {
  visible: "visible",
  pending_review: "pending",
  hidden_by_flags: "removed",
  removed: "removed",
  deleted_by_author: "deleted",
};

/**
 * A thread's page: the opening post and its replies as a tree, siblings by
 * `sort`, three levels deep. With `postId`, the page starts at that reply.
 * Returns null for a thread that isn't there or was removed.
 */
export async function threadPage(
  db: Db,
  now: Date,
  reader: Reader,
  input: {
    threadId: string;
    postId?: string | null;
    sort?: PostSort;
    show?: readonly string[];
    showAll?: boolean;
  },
): Promise<ThreadPage | null> {
  const [t] = await db
    .select({
      ...threadColumns,
      categorySlug: categories.slug,
      categoryName: categories.name,
      chatOpensAt: threads.chatOpensAt,
      chatClosesAt: threads.chatClosesAt,
      leagueId: threads.leagueId,
      sessionStatus: sessions.status,
      sessionStart: sessions.scheduledStart,
      awaitingResults: awaitingResultsSql,
    })
    .from(threads)
    .innerJoin(categories, eq(categories.id, threads.categoryId))
    .leftJoin(sessions, eq(sessions.id, threads.sessionId))
    .leftJoin(events, eq(events.id, sessions.eventId))
    .leftJoin(users, eq(users.id, threads.authorUserId))
    .leftJoin(profiles, eq(profiles.userId, threads.authorUserId))
    .where(and(eq(threads.id, input.threadId), listable(reader)));
  if (!t) return null;

  const hidden = (
    await hiddenThreads(db, now, reader, [t], input.show, input.showAll)
  ).has(t.id);
  // The same check at the session's start says whether the page hides then.
  const start = t.sessionStart;
  const hidesAt =
    !hidden &&
    start !== null &&
    start > now &&
    (
      await hiddenThreads(db, start, reader, [t], input.show, input.showAll)
    ).has(t.id)
      ? start.toISOString()
      : null;
  const thread = {
    ...toRow(t, hidden),
    categorySlug: t.categorySlug,
    categoryName: t.categoryName,
    sessionId: t.sessionId,
    sessionLabel: t.sessionKind ? SESSION_LABELS[t.sessionKind] : null,
    sessionPhrase: t.sessionKind ? sessionPhrase(t.sessionKind) : null,
    eventName: t.eventName,
    createdAt: t.createdAt.toISOString(),
  };
  const base = {
    thread,
    mode: threadMode(
      now,
      t.sessionStatus
        ? { status: t.sessionStatus, awaitingResults: t.awaitingResults }
        : null,
      t,
    ),
    opensChatAt:
      t.chatOpensAt && t.chatOpensAt > now && t.sessionStatus !== "cancelled"
        ? t.chatOpensAt.toISOString()
        : null,
    hidden,
    hidesAt,
    focusPostId: input.postId ?? null,
  };
  if (hidden) return { ...base, posts: [] };

  let root: { path: string; depth: number } | null = null;
  if (input.postId) {
    const [row] = await db
      .select({ path: posts.path, depth: posts.depth })
      .from(posts)
      .where(
        and(
          eq(posts.id, input.postId),
          eq(posts.threadId, t.id),
          eq(posts.isOpening, false),
        ),
      );
    if (!row) return { ...base, focusPostId: null, posts: [] };
    root = row;
  }

  const rows: PostFacts[] = await db
    .select({
      id: posts.id,
      parentPostId: posts.parentPostId,
      depth: posts.depth,
      isOpening: posts.isOpening,
      authorUserId: posts.authorUserId,
      ...authorColumns,
      trustLevel: profiles.trustLevel,
      body: posts.body,
      status: posts.status,
      score: posts.score,
      createdAt: posts.createdAt,
      editedAt: posts.editedAt,
    })
    .from(posts)
    .leftJoin(users, eq(users.id, posts.authorUserId))
    .leftJoin(profiles, eq(profiles.userId, posts.authorUserId))
    .where(
      and(
        eq(posts.threadId, t.id),
        root ? sql`${posts.path} <@ ${root.path}::ltree` : undefined,
      ),
    );

  const votes = new Map<string, number>();
  if (reader && rows.length > 0) {
    for (const v of await db
      .select({ postId: postVotes.postId, value: postVotes.value })
      .from(postVotes)
      .where(
        and(
          eq(postVotes.userId, reader.userId),
          inArray(
            postVotes.postId,
            rows.map((r) => r.id),
          ),
        ),
      )) {
      votes.set(v.postId, v.value);
    }
  }

  return {
    ...base,
    posts: layOut(rows, {
      reader,
      votes,
      sort: input.sort ?? "best",
      // At the root, the opening post is 0 and its replies start at 1.
      offset: root ? root.depth - 1 : 0,
    }),
  };
}

/** The tree in reading order, cut at the depth cap, placeholders kept where needed. */
function layOut(
  rows: PostFacts[],
  ctx: {
    reader: Reader;
    votes: Map<string, number>;
    sort: PostSort;
    offset: number;
  },
): PostView[] {
  const ids = new Set(rows.map((r) => r.id));
  const children = new Map<string | null, PostFacts[]>();
  for (const r of rows) {
    // A post whose parent isn't loaded is a root of this view.
    const key =
      r.parentPostId && ids.has(r.parentPostId) ? r.parentPostId : null;
    children.set(key, [...(children.get(key) ?? []), r]);
  }
  const bySort =
    ctx.sort === "new"
      ? (a: PostFacts, b: PostFacts) =>
          b.createdAt.getTime() - a.createdAt.getTime()
      : (a: PostFacts, b: PostFacts) =>
          b.score - a.score || a.createdAt.getTime() - b.createdAt.getTime();

  const mine = (r: PostFacts) => ctx.reader?.userId === r.authorUserId;
  /** What a viewer may read of a post: its text, a placeholder, or nothing. */
  const shownState = (r: PostFacts): PostState | null => {
    const state = STATE_OF[r.status] ?? "removed";
    if (state === "visible") return state;
    if (state === "pending" && mine(r)) return state;
    return state === "pending" ? "removed" : state;
  };

  const out: PostView[] = [];
  /** Visible descendants below the cap, counted for "Continue thread". */
  const countBelow = (id: string): number =>
    (children.get(id) ?? []).reduce(
      (n, c) => n + (shownState(c) === "visible" ? 1 : 0) + countBelow(c.id),
      0,
    );
  /** Whether a post or anything under it has text to show. */
  const hasText = (r: PostFacts): boolean => {
    const s = shownState(r);
    if (s === "visible" || s === "pending") return true;
    return (children.get(r.id) ?? []).some(hasText);
  };

  const walk = (r: PostFacts) => {
    // The opening post heads the page even as a placeholder.
    if (!r.isOpening && !hasText(r)) return;
    const depth = r.isOpening ? 0 : r.depth - ctx.offset;
    const state = shownState(r)!;
    const readable = state === "visible" || state === "pending";
    const atCap = depth >= MAX_REPLY_DEPTH;
    out.push({
      id: r.id,
      parentId: r.parentPostId,
      depth,
      isOpening: r.isOpening,
      author: readable ? authorName(r) : null,
      html: readable
        ? renderPost(r.body, { linksAllowed: (r.trustLevel ?? 0) >= 1 }).trim()
        : null,
      state,
      score: r.score,
      myVote: (ctx.votes.get(r.id) ?? 0) as -1 | 0 | 1,
      mine: mine(r),
      source: readable && mine(r) ? r.body : null,
      createdAt: r.createdAt.toISOString(),
      edited: r.editedAt !== null,
      moreReplies: atCap ? countBelow(r.id) : 0,
    });
    if (atCap) return;
    for (const c of [...(children.get(r.id) ?? [])].sort(bySort)) walk(c);
  };

  const roots = children.get(null) ?? [];
  // The opening post leads; its replies follow in `sort` order.
  for (const r of roots.filter((p) => p.isOpening)) walk(r);
  for (const r of roots.filter((p) => !p.isOpening).sort(bySort)) walk(r);
  return out;
}

// --- The profile's recent posts ---------------------------------------------------

export type RecentPost = {
  postId: string;
  threadId: string;
  /** Spoiler-safe for the viewer, like the thread list. */
  title: string;
  /** The first words of the post, without Markdown. */
  excerpt: string;
  href: string;
  createdAt: string;
};

const EXCERPT_CHARS = 120;

function excerptOf(body: string): string {
  const plain = body
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`>#~|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length > EXCERPT_CHARS
    ? `${plain.slice(0, EXCERPT_CHARS - 1).trimEnd()}…`
    : plain;
}

/** The viewer's newest visible posts in public threads (M7 Task 15). */
export async function recentPosts(
  db: Db,
  now: Date,
  viewer: Viewer,
  limit = 5,
): Promise<RecentPost[]> {
  const reader = readerOf(viewer);
  const rows = await db
    .select({
      postId: posts.id,
      body: posts.body,
      postedAt: posts.createdAt,
      threadId: threads.id,
      id: threads.id,
      title: threads.title,
      spoilerSafeTitle: threads.spoilerSafeTitle,
      containsSpoilers: threads.containsSpoilers,
      sessionId: threads.sessionId,
      sessionKind: sessions.kind,
      eventName: events.name,
      createdAt: threads.createdAt,
    })
    .from(posts)
    .innerJoin(threads, eq(threads.id, posts.threadId))
    .leftJoin(sessions, eq(sessions.id, threads.sessionId))
    .leftJoin(events, eq(events.id, sessions.eventId))
    .where(
      and(
        eq(posts.authorUserId, viewer.userId),
        eq(posts.status, "visible"),
        inArray(threads.status, ["open", "locked", "archived"]),
        isNull(threads.leagueId),
      ),
    )
    .orderBy(desc(posts.createdAt), desc(posts.id))
    .limit(limit);
  const hidden = await hiddenThreads(db, now, reader, rows);
  return rows.map((r) => ({
    postId: r.postId,
    threadId: r.threadId,
    title: hidden.has(r.id) ? hiddenTitle(r).title : r.title,
    excerpt: excerptOf(r.body),
    href: `/t/${r.threadId}#post-${r.postId}`,
    createdAt: r.postedAt.toISOString(),
  }));
}
