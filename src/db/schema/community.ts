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
  uniqueIndex,
  jsonb,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import {
  CHAT_BODY_MAX,
  POST_BODY_MAX,
  THREAD_TITLE_MAX,
} from "../../community/limits";
import {
  REPORT_NOTE_MAX,
  REPORT_REASONS,
  REPORT_TARGET_TYPES,
  type ReportReason,
  type ReportTargetType,
} from "../../community/report-values";
import { createdAt, ltree, oneOf } from "./helpers";

export { CHAT_BODY_MAX, POST_BODY_MAX, THREAD_TITLE_MAX };
export { REPORT_REASONS, REPORT_TARGET_TYPES };
export type { ReportReason, ReportTargetType };
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
export const CHAT_STATUSES = ["visible", "removed"] as const;
/** DM 5.9: what a restriction stops. */
export const RESTRICTION_KINDS = ["mute", "chat_ban", "thread_ban"] as const;

export const QUEUE_SOURCES = ["reports", "filter", "auto_hide"] as const;
export type QueueSource = (typeof QUEUE_SOURCES)[number];

/** DM 5.9: the moderation log's actions. */
export const MOD_ACTIONS = [
  "remove",
  "restore",
  "lock",
  "unlock",
  "pin",
  "unpin",
  "move",
  "retitle",
  "warn",
  "mute",
  "unmute",
  "chat_ban",
  "chat_unban",
  "ban",
  "unban",
  "set_trust_level",
] as const;
export type ModAction = (typeof MOD_ACTIONS)[number];

export const QUEUE_STATUSES = ["open", "actioned", "dismissed"] as const;
export type QueueStatus = (typeof QUEUE_STATUSES)[number];

export type CategoryKind = (typeof CATEGORY_KINDS)[number];
export type ThreadKind = (typeof THREAD_KINDS)[number];
export type ThreadStatus = (typeof THREAD_STATUSES)[number];
export type PostStatus = (typeof POST_STATUSES)[number];
export type ChatStatus = (typeof CHAT_STATUSES)[number];
export type RestrictionKind = (typeof RESTRICTION_KINDS)[number];

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
    /** A moderator's slow mode for this thread's chat, over the trust level's. */
    slowModeSeconds: smallint("slow_mode_seconds"),
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
      "threads_slow_mode_check",
      sql`${t.slowModeSeconds} is null or ${t.slowModeSeconds} between 0 and 3600`,
    ),
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

/**
 * DM 5.5: live session chat, apart from posts. The UUIDv7 id is the cursor:
 * a refresh reads a thread's messages after an id, in id order. Archived
 * after 30 days (Task 9).
 */
export const chatMessages = pgTable(
  "chat_messages",
  {
    id: uuid("id").primaryKey(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "restrict" }),
    /** The spoiler scope, copied from the thread. */
    sessionId: uuid("session_id").references(() => sessions.id, {
      onDelete: "restrict",
    }),
    authorUserId: uuid("author_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    /** Plain text, never HTML. */
    body: text("body").notNull(),
    status: text("status", { enum: CHAT_STATUSES })
      .notNull()
      .default("visible"),
    createdAt: createdAt(),
  },
  (t) => [
    check("chat_messages_status_check", oneOf(t.status, CHAT_STATUSES)),
    check(
      "chat_messages_body_length_check",
      sql`char_length(${t.body}) between 1 and ${sql.raw(String(CHAT_BODY_MAX))}`,
    ),
    index("chat_messages_thread_id_idx").on(t.threadId, t.id),
    // Slow mode and rate limits count a person's own recent messages.
    index("chat_messages_author_created_idx").on(t.authorUserId, t.createdAt),
  ],
);

/**
 * DM 5.5: a session thread's chat after 30 days, as one gzip JSON-lines file
 * in object storage (Task 9 writes it). One row per thread: the rows it
 * replaced are gone, and the thread page replays the file.
 */
export const chatArchives = pgTable(
  "chat_archives",
  {
    threadId: uuid("thread_id")
      .primaryKey()
      .references(() => threads.id, { onDelete: "restrict" }),
    objectKey: text("object_key").notNull(),
    messageCount: integer("message_count").notNull(),
    firstMessageAt: timestamp("first_message_at", { withTimezone: true }),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }),
    bytes: integer("bytes").notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    check("chat_archives_count_check", sql`${t.messageCount} >= 0`),
    check("chat_archives_bytes_check", sql`${t.bytes} >= 0`),
  ],
);

/**
 * DM 5.9: active limits on a user. `until` null means until lifted; a
 * restriction counts while `lifted_at` is null and `until` hasn't passed.
 */
export const userRestrictions = pgTable(
  "user_restrictions",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    kind: text("kind", { enum: RESTRICTION_KINDS }).notNull(),
    until: timestamp("until", { withTimezone: true }),
    reason: text("reason").notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    liftedAt: timestamp("lifted_at", { withTimezone: true }),
  },
  (t) => [
    check("user_restrictions_kind_check", oneOf(t.kind, RESTRICTION_KINDS)),
    check(
      "user_restrictions_reason_check",
      sql`length(btrim(${t.reason})) > 0`,
    ),
    index("user_restrictions_active_idx")
      .on(t.userId)
      .where(sql`${t.liftedAt} is null`),
  ],
);

/**
 * DM 5.9: one open item per target. Reports about the same thing group here,
 * a filter hit opens one too, and `content_snapshot` keeps what was posted
 * when it was first queued, with each later edit appended, so the evidence
 * survives edits, deletes and the chat archive.
 */
export const modQueueItems = pgTable(
  "mod_queue_items",
  {
    id: uuid("id").primaryKey(),
    targetType: text("target_type", { enum: REPORT_TARGET_TYPES }).notNull(),
    targetId: uuid("target_id").notNull(),
    /** Whose content it is, for per-user moderation history. */
    targetUserId: uuid("target_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    source: text("source", { enum: QUEUE_SOURCES }).notNull(),
    reportCount: integer("report_count").notNull().default(0),
    weightSum: real("weight_sum").notNull().default(0),
    contentSnapshot: jsonb("content_snapshot").notNull(),
    filterHits: jsonb("filter_hits"),
    status: text("status", { enum: QUEUE_STATUSES }).notNull().default("open"),
    resolvedBy: uuid("resolved_by").references(() => users.id, {
      onDelete: "restrict",
    }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolution: text("resolution"),
    version: integer("version").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "mod_queue_items_target_type_check",
      oneOf(t.targetType, REPORT_TARGET_TYPES),
    ),
    check("mod_queue_items_source_check", oneOf(t.source, QUEUE_SOURCES)),
    check("mod_queue_items_status_check", oneOf(t.status, QUEUE_STATUSES)),
    check("mod_queue_items_counts_check", sql`${t.reportCount} >= 0`),
    uniqueIndex("mod_queue_items_open_target_unique")
      .on(t.targetType, t.targetId)
      .where(sql`${t.status} = 'open'`),
    index("mod_queue_items_open_idx")
      .on(t.status, t.createdAt)
      .where(sql`${t.status} = 'open'`),
    index("mod_queue_items_target_user_idx").on(t.targetUserId),
  ],
);

/**
 * DM 5.8: a report, from anyone. A logged-out one has no reporter but a
 * contact address, cleared when its item is resolved. One report per person
 * per target.
 */
export const reports = pgTable(
  "reports",
  {
    id: uuid("id").primaryKey(),
    queueItemId: uuid("queue_item_id")
      .notNull()
      .references(() => modQueueItems.id, { onDelete: "restrict" }),
    targetType: text("target_type", { enum: REPORT_TARGET_TYPES }).notNull(),
    targetId: uuid("target_id").notNull(),
    reporterUserId: uuid("reporter_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    reporterContact: text("reporter_contact"),
    reason: text("reason", { enum: REPORT_REASONS }).notNull(),
    note: text("note"),
    weight: real("weight").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check(
      "reports_target_type_check",
      oneOf(t.targetType, REPORT_TARGET_TYPES),
    ),
    check("reports_reason_check", oneOf(t.reason, REPORT_REASONS)),
    check("reports_weight_check", sql`${t.weight} >= 0`),
    check(
      "reports_note_length_check",
      sql`${t.note} is null or char_length(${t.note}) <= ${sql.raw(String(REPORT_NOTE_MAX))}`,
    ),
    uniqueIndex("reports_reporter_target_unique")
      .on(t.targetType, t.targetId, t.reporterUserId)
      .where(sql`${t.reporterUserId} is not null`),
    index("reports_queue_item_idx").on(t.queueItemId),
    index("reports_reporter_idx").on(t.reporterUserId),
  ],
);

/**
 * DM 5.9: the moderation log. Users see the actions taken against them; each
 * also writes `audit_log`. `moderator_user_id` is null for the system and for
 * the staff workflow, whose login is in the audit row.
 */
export const modActions = pgTable(
  "mod_actions",
  {
    id: uuid("id").primaryKey(),
    moderatorUserId: uuid("moderator_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    action: text("action", { enum: MOD_ACTIONS }).notNull(),
    targetType: text("target_type", { enum: REPORT_TARGET_TYPES }).notNull(),
    targetId: uuid("target_id").notNull(),
    targetUserId: uuid("target_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    reason: text("reason").notNull(),
    until: timestamp("until", { withTimezone: true }),
    queueItemId: uuid("queue_item_id").references(() => modQueueItems.id, {
      onDelete: "restrict",
    }),
    createdAt: createdAt(),
  },
  (t) => [
    check("mod_actions_action_check", oneOf(t.action, MOD_ACTIONS)),
    check(
      "mod_actions_target_type_check",
      oneOf(t.targetType, REPORT_TARGET_TYPES),
    ),
    check("mod_actions_reason_check", sql`length(btrim(${t.reason})) > 0`),
    index("mod_actions_target_user_idx").on(t.targetUserId, t.createdAt),
    index("mod_actions_target_idx").on(t.targetType, t.targetId),
    index("mod_actions_moderator_idx").on(t.moderatorUserId),
  ],
);
