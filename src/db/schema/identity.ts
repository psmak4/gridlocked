import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, oneOf, updatedAt } from "./helpers";
import { constructors, drivers } from "./reference";

// Identity and accounts (DM Part 6, 5.9, 5.11). Every user column in the
// tables here points at `users` with a real foreign key. Better Auth's own
// tables cascade from a user; ours restrict, because a user is anonymized
// (DM 6.7), never deleted.

export const USER_ROLES = ["user", "moderator", "admin", "system"] as const;
export type UserRole = (typeof USER_ROLES)[number];
export const PROFILE_STATUSES = ["active", "deleted"] as const;
export const TRUST_LEVEL_SOURCES = ["auto", "moderator"] as const;
export const LEGAL_DOCUMENT_KINDS = [
  "terms",
  "privacy",
  "community_rules",
] as const;
export const PRIVACY_REQUEST_KINDS = ["export", "delete"] as const;
export const PRIVACY_REQUEST_STATUSES = [
  "pending",
  "processing",
  "completed",
  "failed",
] as const;
export const FILTER_MATCH_TYPES = ["word", "regex", "domain"] as const;
export const FILTER_EFFECTS = ["block", "hold_for_review", "flag"] as const;
export const FILTER_SCOPES = ["all", "titles", "chat", "usernames"] as const;
export const EMAIL_TEMPLATES = [
  "verify_email",
  "magic_link",
  "password_reset",
  "email_change_notice",
  "delete_confirm",
] as const;
export const EMAIL_STATUSES = ["queued", "sent", "failed", "expired"] as const;

// --- Better Auth's tables (DM 6.1) ------------------------------------------
//
// The shape was read from Better Auth 1.7.10: the core schema plus the admin,
// username and two-factor plugins, and the `rateLimit` model. Task 3 of M5
// re-checks it against 1.7.18. Names are ours (DM 0.1); ids are made by the app
// (`newId()`), so there are no database defaults on them. Columns are exactly
// what Better Auth reads and writes, plus the extras marked "ours".

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    // Admin plugin. `role` is the single source of truth (DM 6.4).
    role: text("role", { enum: USER_ROLES }).notNull().default("user"),
    banned: boolean("banned").notNull().default(false),
    banReason: text("ban_reason"),
    banExpires: timestamp("ban_expires", { withTimezone: true }),
    // Username plugin. Its column is unique as written; the index on
    // `lower(username)` below is what makes it case-insensitive (DM 6.3).
    username: text("username").unique(),
    displayUsername: text("display_username"),
    // Two-factor plugin.
    twoFactorEnabled: boolean("two_factor_enabled").notNull().default(false),
  },
  (t) => [
    check("users_role_check", oneOf(t.role, USER_ROLES)),
    uniqueIndex("users_username_lower_idx").on(sql`lower(${t.username})`),
  ],
);

export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Admin plugin: the admin acting as this session's user (DM 6.4).
    impersonatedBy: uuid("impersonated_by").references(() => users.id, {
      onDelete: "set null",
    }),
    /** Ours: when this session last passed a staff re-check (DM 6.4). */
    staffVerifiedAt: timestamp("staff_verified_at", { withTimezone: true }),
  },
  (t) => [
    index("auth_sessions_user_id_idx").on(t.userId),
    index("auth_sessions_expires_at_idx").on(t.expiresAt),
  ],
);

export const authAccounts = pgTable(
  "auth_accounts",
  {
    id: uuid("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
    }),
    scope: text("scope"),
    /** The password hash, for the `credential` provider. */
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("auth_accounts_user_id_idx").on(t.userId)],
);

export const authVerifications = pgTable(
  "auth_verifications",
  {
    id: uuid("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("auth_verifications_identifier_idx").on(t.identifier)],
);

/** Two-factor plugin. `verified` defaults to true, as the plugin's does. */
export const authTwoFactors = pgTable(
  "auth_two_factors",
  {
    id: uuid("id").primaryKey(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    verified: boolean("verified").notNull().default(true),
    failedVerificationCount: integer("failed_verification_count")
      .notNull()
      .default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
  },
  (t) => [
    index("auth_two_factors_secret_idx").on(t.secret),
    index("auth_two_factors_user_id_idx").on(t.userId),
  ],
);

/** Better Auth's database-backed rate limiter. `last_request` is epoch milliseconds. */
export const authRateLimits = pgTable("auth_rate_limits", {
  id: uuid("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});

// --- Ours ---------------------------------------------------------------------

/** DM 6.2: everything about a user that isn't sign-in. */
export const profiles = pgTable(
  "profiles",
  {
    userId: uuid("user_id")
      .primaryKey()
      .references(() => users.id, { onDelete: "restrict" }),
    status: text("status", { enum: PROFILE_STATUSES }).notNull(),
    avatarSeed: text("avatar_seed").notNull(),
    favoriteConstructorId: uuid("favorite_constructor_id").references(
      () => constructors.id,
      { onDelete: "restrict" },
    ),
    favoriteDriverId: uuid("favorite_driver_id").references(() => drivers.id, {
      onDelete: "restrict",
    }),
    /** ISO 3166-1 alpha-2, optional and self-declared. */
    countryCode: text("country_code"),
    /** IANA name; the browser's at sign-up. */
    timezone: text("timezone").notNull().default("UTC"),
    spoilerProtection: boolean("spoiler_protection").notNull().default(true),
    /** That the user confirmed they are 16 or older, not their birth date. */
    ageConfirmedAt: timestamp("age_confirmed_at", { withTimezone: true }),
    trustLevel: smallint("trust_level").notNull().default(0),
    /** A moderator fixed the level by hand, so the nightly job leaves it. */
    trustLevelLocked: boolean("trust_level_locked").notNull().default(false),
    reputation: integer("reputation").notNull().default(0),
    daysVisited: integer("days_visited").notNull().default(0),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    broadcastsReadAt: timestamp("broadcasts_read_at", { withTimezone: true }),
    usernameChangedAt: timestamp("username_changed_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    check("profiles_status_check", oneOf(t.status, PROFILE_STATUSES)),
    check("profiles_trust_level_check", sql`${t.trustLevel} between 0 and 3`),
    index("profiles_favorite_constructor_id_idx").on(t.favoriteConstructorId),
    index("profiles_favorite_driver_id_idx").on(t.favoriteDriverId),
    index("profiles_country_code_idx").on(t.countryCode),
    index("profiles_status_last_seen_at_idx").on(t.status, t.lastSeenAt),
  ],
);

/** DM 6.3: old usernames, which stay reserved for 90 days. */
export const usernameHistory = pgTable(
  "username_history",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    username: text("username").notNull(),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    index("username_history_user_id_idx").on(t.userId),
    index("username_history_username_lower_changed_at_idx").on(
      sql`lower(${t.username})`,
      t.changedAt,
    ),
  ],
);

/** DM 6.5: a readable history of a user's trust level. */
export const trustLevelChanges = pgTable(
  "trust_level_changes",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    fromLevel: smallint("from_level").notNull(),
    toLevel: smallint("to_level").notNull(),
    source: text("source", { enum: TRUST_LEVEL_SOURCES }).notNull(),
    /** The moderator, for source `moderator`. */
    changedBy: uuid("changed_by").references(() => users.id, {
      onDelete: "restrict",
    }),
    reason: text("reason"),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    check(
      "trust_level_changes_levels_check",
      sql`${t.fromLevel} between 0 and 3 and ${t.toLevel} between 0 and 3`,
    ),
    check(
      "trust_level_changes_source_check",
      oneOf(t.source, TRUST_LEVEL_SOURCES),
    ),
    index("trust_level_changes_user_id_changed_at_idx").on(
      t.userId,
      t.changedAt,
    ),
  ],
);

/** DM 6.8: the documents themselves are pages on the site. */
export const legalDocuments = pgTable(
  "legal_documents",
  {
    id: uuid("id").primaryKey(),
    kind: text("kind", { enum: LEGAL_DOCUMENT_KINDS }).notNull(),
    version: text("version").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    requiresReacceptance: boolean("requires_reacceptance")
      .notNull()
      .default(false),
    url: text("url").notNull(),
  },
  (t) => [
    check("legal_documents_kind_check", oneOf(t.kind, LEGAL_DOCUMENT_KINDS)),
    unique("legal_documents_kind_version_unique").on(t.kind, t.version),
  ],
);

export const legalAcceptances = pgTable(
  "legal_acceptances",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => legalDocuments.id, { onDelete: "restrict" }),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.documentId] })],
);

/** DM 6.7: data export and account deletion requests. */
export const privacyRequests = pgTable(
  "privacy_requests",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    kind: text("kind", { enum: PRIVACY_REQUEST_KINDS }).notNull(),
    status: text("status", { enum: PRIVACY_REQUEST_STATUSES })
      .notNull()
      .default("pending"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    /** An export file in object storage. */
    exportObjectKey: text("export_object_key"),
    exportExpiresAt: timestamp("export_expires_at", { withTimezone: true }),
    /** Where the user downloads the export. */
    exportUrl: text("export_url"),
    /** A deletion waits for the user to confirm by email; only the hash is kept. */
    confirmTokenHash: text("confirm_token_hash"),
    confirmExpiresAt: timestamp("confirm_expires_at", { withTimezone: true }),
  },
  (t) => [
    check("privacy_requests_kind_check", oneOf(t.kind, PRIVACY_REQUEST_KINDS)),
    check(
      "privacy_requests_status_check",
      oneOf(t.status, PRIVACY_REQUEST_STATUSES),
    ),
    index("privacy_requests_user_id_idx").on(t.userId),
    index("privacy_requests_open_status_idx")
      .on(t.status)
      .where(sql`${t.status} in ('pending', 'processing')`),
  ],
);

/**
 * DM 5.9: the hard-rule filters. Config, editable by admins and audited. For
 * `usernames` scope they are the reserved names (DM 6.3); the migration seeds
 * those. A `regex` pattern is matched case-insensitively.
 */
export const filterRules = pgTable(
  "filter_rules",
  {
    id: uuid("id").primaryKey(),
    pattern: text("pattern").notNull(),
    matchType: text("match_type", { enum: FILTER_MATCH_TYPES }).notNull(),
    effect: text("effect", { enum: FILTER_EFFECTS }).notNull(),
    scope: text("scope", { enum: FILTER_SCOPES }).notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      "filter_rules_match_type_check",
      oneOf(t.matchType, FILTER_MATCH_TYPES),
    ),
    check("filter_rules_effect_check", oneOf(t.effect, FILTER_EFFECTS)),
    check("filter_rules_scope_check", oneOf(t.scope, FILTER_SCOPES)),
    index("filter_rules_scope_active_idx").on(t.scope, t.active),
  ],
);

/**
 * DM 5.11: account emails waiting for the daily cap. `to_email` is null once a
 * row is sent, expired or scrubbed (DM 6.7), but a queued row needs one.
 */
export const emailOutbox = pgTable(
  "email_outbox",
  {
    id: uuid("id").primaryKey(),
    toEmail: text("to_email"),
    template: text("template", { enum: EMAIL_TEMPLATES }).notNull(),
    payload: jsonb("payload").notNull().default({}),
    status: text("status", { enum: EMAIL_STATUSES })
      .notNull()
      .default("queued"),
    attempts: integer("attempts").notNull().default(0),
    sendAfter: timestamp("send_after", { withTimezone: true }).notNull(),
    providerMessageId: text("provider_message_id"),
    createdAt: createdAt(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    /** A magic link or reset past this is expired, not sent. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    lastError: text("last_error"),
  },
  (t) => [
    check("email_outbox_template_check", oneOf(t.template, EMAIL_TEMPLATES)),
    check("email_outbox_status_check", oneOf(t.status, EMAIL_STATUSES)),
    check(
      "email_outbox_queued_to_email_check",
      sql`${t.status} <> 'queued' or ${t.toEmail} is not null`,
    ),
    uniqueIndex("email_outbox_queued_to_email_template_idx")
      .on(sql`lower(${t.toEmail})`, t.template)
      .where(sql`${t.status} = 'queued'`),
    index("email_outbox_status_send_after_idx").on(t.status, t.sendAfter),
  ],
);
