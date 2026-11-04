import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  pgView,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { oneOf } from "./helpers";
import { games, poolAssets, rulesetVersions, teams } from "./game";
import { drivers, events, sessions } from "./reference";

// Scoring and standings (DM Part 4): the two-tier ledger. Tier 1 is the asset
// score lines every team shares; tier 2 is what is specific to one team. Base
// lines (an asset's points in a team's lineup) are a view, not rows (DM 4.0).
// Points only: this layer reads results through `effective_results` and game
// data, and never writes either (DM 0.5).
//
// Not defined here, because Drizzle cannot express them: the views
// `asset_session_totals` and `team_base_lines` (only typed `.existing()`
// handles are declared). They live in the `ledger_rules` migration.

/** What started a run (DM 4.1). */
export const SCORING_RUN_TRIGGERS = [
  "results",
  "override",
  "exception",
  "ruleset_correction",
  "engine_change",
  "admin",
  "replay",
] as const;
/** `dry_run` computes and reports differences without writing (DM 4.9). */
export const SCORING_RUN_MODES = ["live", "dry_run"] as const;
export const SCORING_RUN_STATUSES = [
  "running",
  "succeeded",
  "failed",
  "superseded",
] as const;
/** Each is its own visible line on a team's explanation (DM 4.3). */
export const ADJUSTMENT_LINE_TYPES = [
  "boost",
  "triple_boost",
  "autopilot_remove",
  "autopilot_add",
  "no_negative",
  "transfer_penalty",
] as const;

/**
 * DM 4.1: every attempt at scoring a session, and which one counts. A step
 * that finds a newer run of the same mode for the session stops and marks its
 * run `superseded`, so the later run wins.
 */
export const scoringRuns = pgTable(
  "scoring_runs",
  {
    id: uuid("id").primaryKey(),
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "restrict" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "restrict" }),
    rulesetVersionId: uuid("ruleset_version_id")
      .notNull()
      .references(() => rulesetVersions.id, { onDelete: "restrict" }),
    /** The scoring code's version (`ENGINE_VERSION`); a bug fix bumps it. */
    engineVersion: text("engine_version").notNull(),
    /**
     * SHA-256 of everything the run read. A live run whose fingerprint is the
     * current run's is skipped.
     */
    inputFingerprint: text("input_fingerprint").notNull(),
    trigger: text("trigger", { enum: SCORING_RUN_TRIGGERS }).notNull(),
    mode: text("mode", { enum: SCORING_RUN_MODES }).notNull(),
    status: text("status", { enum: SCORING_RUN_STATUSES }).notNull(),
    /** The run whose lines are the session's. At most one per session. */
    isCurrent: boolean("is_current").notNull().default(false),
    /**
     * The effective results rows and the session exception, as scored. Null
     * until the run writes its lines.
     */
    inputs: jsonb("inputs"),
    /** Assets and teams whose points changed against the previous current run. */
    diffSummary: jsonb("diff_summary"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    check("scoring_runs_trigger_check", oneOf(t.trigger, SCORING_RUN_TRIGGERS)),
    check("scoring_runs_mode_check", oneOf(t.mode, SCORING_RUN_MODES)),
    check("scoring_runs_status_check", oneOf(t.status, SCORING_RUN_STATUSES)),
    // A dry run never writes lines, so it never counts.
    check(
      "scoring_runs_current_live_check",
      sql`not ${t.isCurrent} or ${t.mode} = 'live'`,
    ),
    uniqueIndex("scoring_runs_game_id_session_id_current_unique")
      .on(t.gameId, t.sessionId)
      .where(sql`${t.isCurrent}`),
  ],
);

/**
 * DM 4.2: tier 1, one line per pool asset per rule that scored in a session,
 * shared by every team. A re-score deletes the session's lines and inserts
 * the new set in one transaction, tagged with its run.
 */
export const assetScoreLines = pgTable(
  "asset_score_lines",
  {
    id: uuid("id").primaryKey(),
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "restrict" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "restrict" }),
    runId: uuid("run_id")
      .notNull()
      .references(() => scoringRuns.id, { onDelete: "restrict" }),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => poolAssets.id, { onDelete: "restrict" }),
    /** `scoring_rules.code`. */
    ruleCode: text("rule_code").notNull(),
    /** Copied from the rule, for Safety Car (No Negative). */
    category: text("category").notNull(),
    /**
     * On a constructor's line, the driver whose points these are; possibly
     * one not in the pool, such as a substitute. Null on a driver's own lines.
     */
    subjectDriverId: uuid("subject_driver_id").references(() => drivers.id, {
      onDelete: "restrict",
    }),
    points: integer("points").notNull(),
    /** For the explanation only, e.g. `{ "grid": 7, "position": 3 }`. */
    detail: jsonb("detail").notNull(),
  },
  (t) => [
    // Its leading columns also serve the DM 4.10 index on (game_id,
    // session_id): the per-session replace and the base-lines join.
    uniqueIndex("asset_score_lines_line_unique").on(
      t.gameId,
      t.sessionId,
      t.assetId,
      t.ruleCode,
      sql`coalesce(${t.subjectDriverId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
    ),
  ],
);

/**
 * DM 4.3: tier 2, what is specific to a team: Boost, the chips that change
 * points and the transfer penalty. A run rewrites all of a team's lines for
 * the event at once, from the current asset lines.
 */
export const teamAdjustmentLines = pgTable(
  "team_adjustment_lines",
  {
    id: uuid("id").primaryKey(),
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "restrict" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "restrict" }),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "restrict" }),
    /** Null for an event-level line: the transfer penalty, Strategist's move. */
    sessionId: uuid("session_id").references(() => sessions.id, {
      onDelete: "restrict",
    }),
    /** The asset the line is about; null for the transfer penalty. */
    assetId: uuid("asset_id").references(() => poolAssets.id, {
      onDelete: "restrict",
    }),
    lineType: text("line_type", { enum: ADJUSTMENT_LINE_TYPES }).notNull(),
    /** For `no_negative`: the category floored. */
    category: text("category"),
    points: integer("points").notNull(),
    /** The run that last wrote it. */
    runId: uuid("run_id")
      .notNull()
      .references(() => scoringRuns.id, { onDelete: "restrict" }),
  },
  (t) => [
    check(
      "team_adjustment_lines_line_type_check",
      oneOf(t.lineType, ADJUSTMENT_LINE_TYPES),
    ),
    index("team_adjustment_lines_game_id_event_id_idx").on(t.gameId, t.eventId),
    index("team_adjustment_lines_team_id_event_id_idx").on(t.teamId, t.eventId),
  ],
);

/**
 * DM 4.2: a typed handle on the `asset_session_totals` view, created in the
 * `ledger_rules` migration: each asset's points in a session, and its points
 * by rule category (every line of the category, so both of a constructor's
 * drivers together). An asset with no lines has no row.
 */
export const assetSessionTotals = pgView("asset_session_totals", {
  gameId: uuid("game_id").notNull(),
  sessionId: uuid("session_id").notNull(),
  assetId: uuid("asset_id").notNull(),
  points: integer("points").notNull(),
  byCategory: jsonb("by_category").$type<Record<string, number>>().notNull(),
}).existing();

/**
 * DM 4.3: a typed handle on the `team_base_lines` view, created in the
 * `ledger_rules` migration: for each lock record, scored session of its event
 * and asset of the session's effective lineup with points there, the asset's
 * session points. The effective lineup is the locked version, or the Late
 * Call version from the session it applies from (the race).
 */
export const teamBaseLines = pgView("team_base_lines", {
  gameId: uuid("game_id").notNull(),
  teamId: uuid("team_id").notNull(),
  eventId: uuid("event_id").notNull(),
  sessionId: uuid("session_id").notNull(),
  assetId: uuid("asset_id").notNull(),
  points: integer("points").notNull(),
}).existing();
