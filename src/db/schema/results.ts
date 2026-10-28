import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  pgView,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, oneOf } from "./helpers";
import { jobs } from "./jobs";
import {
  constructors,
  drivers,
  events,
  seasons,
  SESSION_KINDS,
  sessions,
} from "./reference";

// Ingestion and results (DM Part 2): how provider data comes in, becomes
// per-session facts, and gets corrected. Facts only, never points (DM 0.5).
// Foreign keys point down the stack: to reference data and to `jobs`.
//
// Not defined here, because Drizzle cannot express them: the `effective_results`
// view (only a typed `.existing()` handle is declared) and the triggers
// (`results.session_kind`, the blocking-review guard). They live in the
// `results_rules` migration.
//
// Columns that DM 2.x marks "FK -> users" are plain `uuid`s for now. The users
// table arrives in M5, which adds the foreign keys.

export const PROVIDER_REQUEST_OUTCOMES = [
  "new_snapshot",
  "unchanged",
  "error",
  "rate_limited",
] as const;
export const RESULT_STATES = [
  "awaiting",
  "provisional",
  "under_review",
  "final",
] as const;
export const RESULT_SOURCES = ["provider", "manual"] as const;
export const CLASSIFICATIONS = [
  "classified",
  "not_classified",
  "disqualified",
  "did_not_start",
  "did_not_qualify",
  "excluded",
] as const;
export const OVERRIDE_KINDS = ["patch", "insert", "suppress"] as const;
export const REVIEW_SEVERITIES = ["blocking", "warning"] as const;
export const REVIEW_STATUSES = ["open", "resolved", "dismissed"] as const;

/** DM 2.2: exactly what a provider said. Append-only. */
export const rawSnapshots = pgTable(
  "raw_snapshots",
  {
    id: uuid("id").primaryKey(),
    provider: text("provider").notNull(),
    endpoint: text("endpoint").notNull(),
    /** Hash of `(provider, endpoint, params)`: "the same question". */
    paramsHash: text("params_hash").notNull(),
    /** SHA-256 of the canonical-JSON body, so key order is not a change. */
    contentHash: text("content_hash").notNull(),
    body: jsonb("body").notNull(),
    bodyBytes: integer("body_bytes").notNull(),
    firstFetchedAt: timestamp("first_fetched_at", {
      withTimezone: true,
    }).notNull(),
    /** Bumped when the same content is fetched again. */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    seasonId: uuid("season_id").references(() => seasons.id, {
      onDelete: "restrict",
    }),
    eventId: uuid("event_id").references(() => events.id, {
      onDelete: "restrict",
    }),
    sessionId: uuid("session_id").references(() => sessions.id, {
      onDelete: "restrict",
    }),
  },
  (t) => [
    // The same answer to the same question is stored once.
    unique("raw_snapshots_params_hash_content_hash_unique").on(
      t.paramsHash,
      t.contentHash,
    ),
    // "Latest snapshot for this question".
    index("raw_snapshots_params_hash_first_fetched_at_idx").on(
      t.paramsHash,
      t.firstFetchedAt.desc(),
    ),
    index("raw_snapshots_session_id_idx").on(t.sessionId),
  ],
);

/** DM 2.1: the HTTP call log. Operational data, pruned after 30 days. */
export const providerRequests = pgTable(
  "provider_requests",
  {
    id: uuid("id").primaryKey(),
    provider: text("provider").notNull(),
    endpoint: text("endpoint").notNull(),
    /** Normalized query parameters. */
    params: jsonb("params").notNull(),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
    /** Null on a network error. */
    statusCode: integer("status_code"),
    durationMs: integer("duration_ms").notNull(),
    outcome: text("outcome", { enum: PROVIDER_REQUEST_OUTCOMES }).notNull(),
    /** The snapshot this call produced or matched. */
    snapshotId: uuid("snapshot_id").references(() => rawSnapshots.id, {
      onDelete: "restrict",
    }),
    error: text("error"),
    /**
     * Which job made the call. A diagnostic pointer on 30-day operational
     * data, so pruning a job just clears it (SET NULL, unlike the RESTRICT
     * used for facts).
     */
    jobId: uuid("job_id").references(() => jobs.id, { onDelete: "set null" }),
  },
  (t) => [
    check(
      "provider_requests_outcome_check",
      oneOf(t.outcome, PROVIDER_REQUEST_OUTCOMES),
    ),
    index("provider_requests_requested_at_idx").on(t.requestedAt),
  ],
);

/** DM 2.3: one row per session, saying where its results stand. */
export const sessionResultState = pgTable(
  "session_result_state",
  {
    sessionId: uuid("session_id")
      .primaryKey()
      .references(() => sessions.id, { onDelete: "restrict" }),
    status: text("status", { enum: RESULT_STATES })
      .notNull()
      .default("awaiting"),
    /** `manual` means an admin entered the whole session (DM 2.6). */
    source: text("source", { enum: RESULT_SOURCES })
      .notNull()
      .default("provider"),
    /** The snapshot the current `results` rows were normalized from. */
    currentSnapshotId: uuid("current_snapshot_id").references(
      () => rawSnapshots.id,
      { onDelete: "restrict" },
    ),
    pollAttempts: integer("poll_attempts").notNull().default(0),
    nextPollAt: timestamp("next_poll_at", { withTimezone: true }),
    /** Set when the poll window runs out; raises an admin alert. */
    gaveUpAt: timestamp("gave_up_at", { withTimezone: true }),
    finalizedAt: timestamp("finalized_at", { withTimezone: true }),
    reopenedCount: integer("reopened_count").notNull().default(0),
    /** Optimistic concurrency (DM 0.7). */
    version: integer("version").notNull().default(1),
  },
  (t) => [
    check("session_result_state_status_check", oneOf(t.status, RESULT_STATES)),
    check("session_result_state_source_check", oneOf(t.source, RESULT_SOURCES)),
  ],
);

/**
 * DM 2.4: normalized provider facts, one row per driver per session. Nothing
 * reads this directly: scoring, pages and posts read `effective_results`.
 */
export const results = pgTable(
  "results",
  {
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "restrict" }),
    driverId: uuid("driver_id")
      .notNull()
      .references(() => drivers.id, { onDelete: "restrict" }),
    /** The car driven in this session. Constructor points follow this. */
    constructorId: uuid("constructor_id")
      .notNull()
      .references(() => constructors.id, { onDelete: "restrict" }),
    /** Provenance. */
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => rawSnapshots.id, { onDelete: "restrict" }),
    /**
     * Beyond DM 2.4's column list: a copy of `sessions.kind`, set by a trigger
     * on every insert and update so the session-specific CHECKs below can see
     * it. The default is a value the CHECK rejects, so a row can never keep it
     * if the trigger is missing. Callers never set this.
     */
    sessionKind: text("session_kind", { enum: SESSION_KINDS })
      .notNull()
      .default(sql`'unset'`),
    carNumber: integer("car_number").notNull(),
    /** As the provider gives it. In qualifying, never derived from lap times. */
    position: integer("position"),
    classification: text("classification", {
      enum: CLASSIFICATIONS,
    }).notNull(),
    /** Kept as given: `Finished`, `Lapped`, `Retired`, `Did not start`, ... */
    providerStatus: text("provider_status").notNull(),
    /** `1`, `R`, `W`, `D`, ... */
    providerPositionText: text("provider_position_text").notNull(),
    /** Sprint and race only. Null for a pit-lane start. */
    grid: integer("grid"),
    /** Jolpica reports it as `grid = 0`. Scoring treats it as last on the grid. */
    pitLaneStart: boolean("pit_lane_start").notNull().default(false),
    laps: integer("laps"),
    timeMs: bigint("time_ms", { mode: "number" }),
    fastestLapRank: integer("fastest_lap_rank"),
    fastestLapMs: integer("fastest_lap_ms"),
    /** Qualifying and sprint qualifying only. No time is null, never `""`. */
    q1Ms: integer("q1_ms"),
    q2Ms: integer("q2_ms"),
    q3Ms: integer("q3_ms"),
    /** Championship points for hub pages. Never used in fantasy scoring. */
    officialPoints: numeric("official_points", { precision: 4, scale: 1 }),
  },
  (t) => [
    primaryKey({
      name: "results_pkey",
      columns: [t.sessionId, t.driverId],
    }),
    check("results_session_kind_check", oneOf(t.sessionKind, SESSION_KINDS)),
    check(
      "results_classification_check",
      oneOf(t.classification, CLASSIFICATIONS),
    ),
    check(
      "results_grid_sprint_race_only_check",
      sql`${t.sessionKind} in ('sprint', 'race') or (${t.grid} is null and ${t.pitLaneStart} = false)`,
    ),
    check(
      "results_pit_lane_start_grid_check",
      sql`${t.pitLaneStart} = false or ${t.grid} is null`,
    ),
    check(
      "results_q_times_qualifying_only_check",
      sql`${t.sessionKind} in ('qualifying', 'sprint_qualifying') or (${t.q1Ms} is null and ${t.q2Ms} is null and ${t.q3Ms} is null)`,
    ),
  ],
);

/** DM 2.5: what changed between snapshots. Written with the rows. */
export const resultChanges = pgTable("result_changes", {
  id: uuid("id").primaryKey(),
  sessionId: uuid("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "restrict" }),
  driverId: uuid("driver_id")
    .notNull()
    .references(() => drivers.id, { onDelete: "restrict" }),
  /** A `results` column name, e.g. `position`. */
  field: text("field").notNull(),
  /** Null when the field was empty (or the row was absent) on that side. */
  oldValue: text("old_value"),
  newValue: text("new_value"),
  fromSnapshotId: uuid("from_snapshot_id")
    .notNull()
    .references(() => rawSnapshots.id, { onDelete: "restrict" }),
  toSnapshotId: uuid("to_snapshot_id")
    .notNull()
    .references(() => rawSnapshots.id, { onDelete: "restrict" }),
  detectedAt: timestamp("detected_at", { withTimezone: true }).notNull(),
});

/** DM 2.6: the admin layer over provider rows. */
export const resultOverrides = pgTable(
  "result_overrides",
  {
    id: uuid("id").primaryKey(),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "restrict" }),
    driverId: uuid("driver_id")
      .notNull()
      .references(() => drivers.id, { onDelete: "restrict" }),
    kind: text("kind", { enum: OVERRIDE_KINDS }).notNull(),
    /**
     * For `patch` and `insert`: only the fields being set, under `results`'
     * column names (snake_case). Validated by a Zod schema in application
     * code. `{}` for `suppress`. jsonb on purpose, against DM 0.3: it holds an
     * arbitrary subset and is never queried by those fields.
     */
    fields: jsonb("fields").notNull().default({}),
    reason: text("reason").notNull(),
    // FK to users added in M5
    createdBy: uuid("created_by").notNull(),
    createdAt: createdAt(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    // FK to users added in M5
    revokedBy: uuid("revoked_by"),
    version: integer("version").notNull().default(1),
  },
  (t) => [
    check("result_overrides_kind_check", oneOf(t.kind, OVERRIDE_KINDS)),
    // `effective_results` reads `fields` with jsonb operators, which need an object.
    check(
      "result_overrides_fields_object_check",
      sql`jsonb_typeof(${t.fields}) = 'object'`,
    ),
    // An insert builds a whole row, so it must carry every NOT NULL column
    // that `effective_results` cannot fill in itself.
    check(
      "result_overrides_insert_fields_check",
      sql`${t.kind} <> 'insert' or ${t.fields} ?& array['constructor_id', 'car_number', 'classification', 'provider_status', 'provider_position_text']`,
    ),
    // A patch or insert that sets nothing is a mistake. Only a suppress is empty.
    check(
      "result_overrides_fields_not_empty_check",
      sql`${t.kind} = 'suppress' or ${t.fields} <> '{}'::jsonb`,
    ),
    // At most one active override per driver per session. Its leading column
    // also serves the DM 2.12 index on (session_id) WHERE revoked_at IS NULL.
    uniqueIndex("result_overrides_session_id_driver_id_active_unique")
      .on(t.sessionId, t.driverId)
      .where(sql`${t.revokedAt} is null`),
  ],
);

/**
 * DM 2.7: a typed handle on the `effective_results` view for reads. The view
 * itself is created in the `results_rules` migration, so this is `.existing()`:
 * drizzle-kit does not generate it. Keep the columns in step with that
 * migration. `snapshotId` is null for rows that come from an `insert` override.
 */
export const effectiveResults = pgView("effective_results", {
  sessionId: uuid("session_id").notNull(),
  driverId: uuid("driver_id").notNull(),
  snapshotId: uuid("snapshot_id"),
  sessionKind: text("session_kind", { enum: SESSION_KINDS }).notNull(),
  constructorId: uuid("constructor_id").notNull(),
  carNumber: integer("car_number").notNull(),
  position: integer("position"),
  classification: text("classification", { enum: CLASSIFICATIONS }).notNull(),
  providerStatus: text("provider_status").notNull(),
  providerPositionText: text("provider_position_text").notNull(),
  grid: integer("grid"),
  pitLaneStart: boolean("pit_lane_start").notNull(),
  laps: integer("laps"),
  timeMs: bigint("time_ms", { mode: "number" }),
  fastestLapRank: integer("fastest_lap_rank"),
  fastestLapMs: integer("fastest_lap_ms"),
  q1Ms: integer("q1_ms"),
  q2Ms: integer("q2_ms"),
  q3Ms: integer("q3_ms"),
  officialPoints: numeric("official_points", { precision: 4, scale: 1 }),
  overridden: boolean("overridden").notNull(),
  overrideReason: text("override_reason"),
}).existing();

/** DM 2.8: who took part in practice, the roster signal. */
export const sessionParticipants = pgTable(
  "session_participants",
  {
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "restrict" }),
    driverId: uuid("driver_id")
      .notNull()
      .references(() => drivers.id, { onDelete: "restrict" }),
    constructorId: uuid("constructor_id")
      .notNull()
      .references(() => constructors.id, { onDelete: "restrict" }),
    provider: text("provider").notNull(),
    snapshotId: uuid("snapshot_id")
      .notNull()
      .references(() => rawSnapshots.id, { onDelete: "restrict" }),
  },
  (t) => [
    primaryKey({
      name: "session_participants_pkey",
      columns: [t.sessionId, t.driverId],
    }),
  ],
);

/** DM 2.9: the admin queue for every "a human must decide". */
export const reviewItems = pgTable(
  "review_items",
  {
    id: uuid("id").primaryKey(),
    /** Open list (e.g. `validation_failed`, `unknown_driver`); no CHECK. */
    kind: text("kind").notNull(),
    /** `blocking` holds scoring for the linked session; `warning` does not. */
    severity: text("severity", { enum: REVIEW_SEVERITIES }).notNull(),
    seasonId: uuid("season_id").references(() => seasons.id, {
      onDelete: "restrict",
    }),
    eventId: uuid("event_id").references(() => events.id, {
      onDelete: "restrict",
    }),
    /** Spoiler scope. */
    sessionId: uuid("session_id").references(() => sessions.id, {
      onDelete: "restrict",
    }),
    driverId: uuid("driver_id").references(() => drivers.id, {
      onDelete: "restrict",
    }),
    /** What was found, shaped per `kind`. */
    details: jsonb("details").notNull().default({}),
    status: text("status", { enum: REVIEW_STATUSES }).notNull().default("open"),
    /** What the admin decided. */
    resolution: text("resolution"),
    // FK to users added in M5
    resolvedBy: uuid("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    /** Unique while open, so a repeated check does not pile up duplicates. */
    dedupeKey: text("dedupe_key").notNull(),
    /** Two admins cannot both resolve it (DM 0.7). */
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
  },
  (t) => [
    check("review_items_severity_check", oneOf(t.severity, REVIEW_SEVERITIES)),
    check("review_items_status_check", oneOf(t.status, REVIEW_STATUSES)),
    uniqueIndex("review_items_dedupe_key_open_unique")
      .on(t.dedupeKey)
      .where(sql`${t.status} = 'open'`),
    // The admin queue.
    index("review_items_open_queue_idx")
      .on(t.status, t.severity, t.createdAt)
      .where(sql`${t.status} = 'open'`),
    // The status-change guard.
    index("review_items_open_blocking_session_id_idx")
      .on(t.sessionId)
      .where(sql`${t.status} = 'open' and ${t.severity} = 'blocking'`),
  ],
);
