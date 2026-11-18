import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import {
  BROADCAST_KINDS,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_KINDS,
  type BroadcastKind,
  type NotificationChannel,
  type NotificationKind,
} from "../../notifications/kinds";
import { posts, threads } from "./community";
import { createdAt, oneOf } from "./helpers";
import { users } from "./identity";
import { leagues } from "./leagues";
import { games, teams } from "./game";
import { events, sessions } from "./reference";

export { BROADCAST_KINDS, NOTIFICATION_CHANNELS, NOTIFICATION_KINDS };
export type { BroadcastKind, NotificationChannel, NotificationKind };

/**
 * DM 5.11: personal notifications. One unread row per `group_key`, counted in
 * place, so a busy thread doesn't flood the table. `data` holds template
 * values, never rendered text: the text is spoiler-safe until `session_id` is
 * revealed, and that is decided when it's shown. Kept 90 days (DM 5.10).
 */
export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    kind: text("kind", { enum: NOTIFICATION_KINDS }).notNull(),
    groupKey: text("group_key"),
    count: integer("count").notNull().default(1),
    actorUserId: uuid("actor_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    threadId: uuid("thread_id").references(() => threads.id, {
      onDelete: "restrict",
    }),
    postId: uuid("post_id").references(() => posts.id, {
      onDelete: "restrict",
    }),
    eventId: uuid("event_id").references(() => events.id, {
      onDelete: "restrict",
    }),
    sessionId: uuid("session_id").references(() => sessions.id, {
      onDelete: "restrict",
    }),
    leagueId: uuid("league_id").references(() => leagues.id, {
      onDelete: "restrict",
    }),
    // A team deleted before it locked (DM 4.2) leaves its notifications.
    teamId: uuid("team_id").references(() => teams.id, {
      onDelete: "set null",
    }),
    data: jsonb("data").notNull().default({}),
    createdAt: createdAt(),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (t) => [
    check("notifications_kind_check", oneOf(t.kind, NOTIFICATION_KINDS)),
    check("notifications_count_check", sql`${t.count} >= 1`),
    uniqueIndex("notifications_unread_group_unique")
      .on(t.userId, t.groupKey)
      .where(sql`${t.readAt} is null and ${t.groupKey} is not null`),
    index("notifications_user_created_idx").on(t.userId, t.createdAt.desc()),
    index("notifications_user_unread_idx")
      .on(t.userId)
      .where(sql`${t.readAt} is null`),
    index("notifications_actor_idx").on(t.actorUserId),
  ],
);

/**
 * DM 5.11: messages for everyone, one row each. The bell merges them with a
 * person's notifications newer than their `broadcasts_read_at`; they're never
 * copied into inboxes.
 */
export const broadcasts = pgTable(
  "broadcasts",
  {
    id: uuid("id").primaryKey(),
    gameId: uuid("game_id").references(() => games.id, {
      onDelete: "restrict",
    }),
    kind: text("kind", { enum: BROADCAST_KINDS }).notNull(),
    sessionId: uuid("session_id").references(() => sessions.id, {
      onDelete: "restrict",
    }),
    eventId: uuid("event_id").references(() => events.id, {
      onDelete: "restrict",
    }),
    /** Makes a broadcast once only, e.g. `scores_in:<session_id>`. */
    dedupeKey: text("dedupe_key").unique(),
    data: jsonb("data").notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [
    check("broadcasts_kind_check", oneOf(t.kind, BROADCAST_KINDS)),
    index("broadcasts_created_idx").on(t.createdAt.desc()),
  ],
);

/** DM 5.11: only the overrides; the defaults live in code. */
export const notificationPreferences = pgTable(
  "notification_preferences",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    kind: text("kind").notNull(),
    channel: text("channel", { enum: NOTIFICATION_CHANNELS }).notNull(),
    enabled: boolean("enabled").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.kind, t.channel] }),
    check(
      "notification_preferences_channel_check",
      oneOf(t.channel, NOTIFICATION_CHANNELS),
    ),
    check(
      "notification_preferences_kind_check",
      sql`${t.kind} in (${sql.raw(
        [...NOTIFICATION_KINDS, ...BROADCAST_KINDS]
          .map((k) => `'${k}'`)
          .join(", "),
      )})`,
    ),
  ],
);

/**
 * DM 5.11: a browser that said yes to push. One row per endpoint; a 404 or
 * 410 from the push service deletes it, and other failures count up.
 */
export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    endpoint: text("endpoint").notNull().unique(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    failureCount: integer("failure_count").notNull().default(0),
  },
  (t) => [index("push_subscriptions_user_idx").on(t.userId)],
);
