import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { createdAt, ltree, oneOf } from "./helpers";
import { users } from "./identity";
import { leagues } from "./leagues";
import { events, sessions } from "./reference";

// The forum (DM 5.2–5.6). Authors are user ids only, never names: a deleted
// account is a tombstone that shows as "deleted user" (DM 5.1). The seven
// categories are seeded by the `community_seed` migration.

/** `race_weekend` turns on the spoiler-title check for new threads. */
export const CATEGORY_KINDS = [
  "general",
  "race_weekend",
  "fantasy",
  "news",
] as const;
export const CATEGORY_STATUSES = ["active", "archived"] as const;
/** HLD §7.1. League threads have a column and wait for after launch. */
export const THREAD_KINDS = [
  "user",
  "session",
  "results",
  "league",
  "rumor",
] as const;
export const THREAD_STATUSES = [
  "open",
  "locked",
  "removed",
  "archived",
] as const;
/** `pending_review`: held by a filter. `hidden_by_flags`: auto-hidden. */
export const POST_STATUSES = [
  "visible",
  "pending_review",
  "hidden_by_flags",
  "removed",
  "deleted_by_author",
] as const;
/** DM 5.4: a post's Markdown source, in characters. */
export const POST_BODY_MAX = 10_000;

export type CategoryKind = (typeof CATEGORY_KINDS)[number];
export type ThreadKind = (typeof THREAD_KINDS)[number];
export type ThreadStatus = (typeof THREAD_STATUSES)[number];
export type PostStatus = (typeof POST_STATUSES)[number];

/** DM 5.2. */
export const categories = pgTable(
  "categories",
  {
    id: uuid("id").primaryKey(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    position: integer("position").notNull(),
    kind: text("kind", { enum: CATEGORY_KINDS }).notNull(),
    minTrustToStartThread: smallint("min_trust_to_start_thread")
      .notNull()
      .default(1),
    status: text("status", { enum: CATEGORY_STATUSES })
      .notNull()
      .default("active"),
  },
  (t) => [
    check("categories_kind_check", oneOf(t.kind, CATEGORY_KINDS)),
    check("categories_status_check", oneOf(t.status, CATEGORY_STATUSES)),
    check(
      "categories_min_trust_check",
      sql`${t.minTrustToStartThread} between 0 and 3`,
    ),
  ],
);

/**
 * DM 5.3. Chat mode or discussion mode is never stored: it comes from the
 * clock, `chat_opens_at` / `chat_closes_at` and the session's status.
 */
export const threads = pgTable(
  "threads",
  {
    id: uuid("id").primaryKey(),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => categories.id, { onDelete: "restrict" }),
    kind: text("kind", { enum: THREAD_KINDS }).notNull(),
    /** The real title. */
    title: text("title").notNull(),
    /** Shown to anyone who hasn't revealed the thread's session. */
    spoilerSafeTitle: text("spoiler_safe_title"),
    containsSpoilers: boolean("contains_spoilers").notNull().default(false),
    /** Null for system-created threads. */
    authorUserId: uuid("author_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    /** The spoiler scope (DM 0.5). */
    sessionId: uuid("session_id").references(() => sessions.id, {
      onDelete: "restrict",
    }),
    eventId: uuid("event_id").references(() => events.id, {
      onDelete: "restrict",
    }),
    leagueId: uuid("league_id").references(() => leagues.id, {
      onDelete: "restrict",
    }),
    chatOpensAt: timestamp("chat_opens_at", { withTimezone: true }),
    chatClosesAt: timestamp("chat_closes_at", { withTimezone: true }),
    status: text("status", { enum: THREAD_STATUSES }).notNull().default("open"),
    pinned: boolean("pinned").notNull().default(false),
    replyCount: integer("reply_count").notNull().default(0),
    score: integer("score").notNull().default(0),
    hotRank: real("hot_rank").notNull().default(0),
    lastActivityAt: timestamp("last_activity_at", {
      withTimezone: true,
    }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check("threads_kind_check", oneOf(t.kind, THREAD_KINDS)),
    check("threads_status_check", oneOf(t.status, THREAD_STATUSES)),
    check(
      "threads_chat_window_check",
      sql`(${t.chatOpensAt} is null) = (${t.chatClosesAt} is null) and (${t.chatOpensAt} is null or ${t.chatOpensAt} < ${t.chatClosesAt})`,
    ),
    index("threads_category_activity_idx")
      .on(t.categoryId, t.lastActivityAt.desc())
      .where(sql`${t.status} in ('open', 'locked')`),
    index("threads_category_hot_idx").on(t.categoryId, t.hotRank.desc()),
    index("threads_session_idx").on(t.sessionId),
    index("threads_event_idx").on(t.eventId),
  ],
);

/**
 * DM 5.4. `path` is the ancestors' ids then the post's own, as ltree labels
 * (the uuid with `_` for `-`). A thread's opening post has no parent and
 * `is_opening`.
 */
export const posts = pgTable(
  "posts",
  {
    id: uuid("id").primaryKey(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "restrict" }),
    parentPostId: uuid("parent_post_id").references(
      (): AnyPgColumn => posts.id,
      { onDelete: "restrict" },
    ),
    path: ltree("path").notNull(),
    depth: smallint("depth").notNull().default(0),
    isOpening: boolean("is_opening").notNull().default(false),
    authorUserId: uuid("author_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    body: text("body").notNull(),
    /** Copied from the thread, so spoiler filtering is one column check. */
    sessionId: uuid("session_id").references(() => sessions.id, {
      onDelete: "restrict",
    }),
    containsSpoilers: boolean("contains_spoilers").notNull().default(false),
    status: text("status", { enum: POST_STATUSES })
      .notNull()
      .default("visible"),
    score: integer("score").notNull().default(0),
    upvotes: integer("upvotes").notNull().default(0),
    downvotes: integer("downvotes").notNull().default(0),
    editCount: smallint("edit_count").notNull().default(0),
    createdAt: createdAt(),
    editedAt: timestamp("edited_at", { withTimezone: true }),
  },
  (t) => [
    check("posts_status_check", oneOf(t.status, POST_STATUSES)),
    check(
      "posts_body_length_check",
      sql`char_length(${t.body}) <= ${sql.raw(String(POST_BODY_MAX))}`,
    ),
    check("posts_depth_check", sql`${t.depth} >= 0`),
    index("posts_thread_path_idx").on(t.threadId, t.path),
    index("posts_author_created_idx").on(t.authorUserId, t.createdAt),
  ],
);

/** DM 5.4: each earlier version of an edited post, for moderators. */
export const postRevisions = pgTable(
  "post_revisions",
  {
    id: uuid("id").primaryKey(),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "restrict" }),
    body: text("body").notNull(),
    editedAt: timestamp("edited_at", { withTimezone: true }).notNull(),
    editedBy: uuid("edited_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => [index("post_revisions_post_idx").on(t.postId, t.editedAt)],
);

/** DM 5.4: drives "you were mentioned". */
export const postMentions = pgTable(
  "post_mentions",
  {
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => [primaryKey({ columns: [t.postId, t.userId] })],
);

/** DM 5.6: one vote per user per post. */
export const postVotes = pgTable(
  "post_votes",
  {
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    value: smallint("value").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.postId, t.userId] }),
    check("post_votes_value_check", sql`${t.value} in (1, -1)`),
    index("post_votes_user_idx").on(t.userId),
  ],
);
