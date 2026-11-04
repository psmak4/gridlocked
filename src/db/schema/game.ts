import { sql } from "drizzle-orm";
import {
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
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { createdAt, oneOf, updatedAt } from "./helpers";
import {
  constructors,
  drivers,
  events,
  seasons,
  SESSION_KINDS,
  sessions,
} from "./reference";

// The fantasy core (DM Part 3): game data. It points down at reference data
// and never the other way (DM 0.5). IDs are UUIDv7 values supplied by the app.
//
// Not declared here, because Drizzle cannot express it: the freeze trigger on
// ruleset_versions and scoring_rules (DM 3.2), events opening in order (DM
// 3.3), the price freeze on asset_prices from the window's opening (DM 3.5),
// the slot limit on teams (DM 3.6), the lineup checks (DM 3.7:
// `saved_at` from app_now(), the window, composition and asset availability at
// commit, and the guard on `events.lock_at`), and the budget with the two
// functions behind it, `team_base_state` and `team_purchasing_power` (DM 3.8),
// and the chip rules (DM 3.9: the code, window and unlock of a play, the
// Final Fix window, the x3 Boost target, and no undo), and the lineup that
// counts at a lock, `team_locked_lineup` (DM 3.9: a lineup saved for a
// cancelled event carries forward). They live in the `game_rules` to
// `game_rules_8` migrations.

export const GAME_TYPES = ["season_fantasy"] as const;
export const GAME_STATUSES = ["setup", "open", "running", "completed"] as const;
/** `scored` and `final` are set by the scoring pipeline (`src/game/score-jobs.ts`). */
export const GAME_EVENT_STATUSES = [
  "upcoming",
  "open",
  "locked",
  "scored",
  "final",
  "cancelled",
] as const;
export const POOL_ASSET_TYPES = ["driver", "constructor"] as const;
export const POOL_ASSET_STATUSES = ["active", "withdrawn"] as const;
/** `formula` is written by the price update (`runPriceUpdate`, DM 3.5). */
export const PRICE_SOURCES = [
  "initial",
  "formula",
  "admin",
  "carried",
] as const;
/** Prices are in units of $0.1M: $3.0M to $34.0M (DM 3.5). */
export const PRICE_MIN = 30;
export const PRICE_MAX = 340;
export const TEAM_STATUSES = ["active", "retired"] as const;
/** `limitless` and `final_fix` are temporary: they apply to one event (DM 3.7). */
export const LINEUP_KINDS = ["regular", "limitless", "final_fix"] as const;
/** `refunded`: only by the system, for a cancelled event (DM 3.9). */
export const CHIP_PLAY_STATUSES = ["played", "refunded"] as const;
/** `skip`: the session isn't scored, e.g. an abandoned race voided (DM 3.9). */
export const SESSION_EXCEPTION_POLICIES = ["skip"] as const;
/** A team's name, in characters (DM 3.6). */
export const TEAM_NAME_MAX = 30;
export const SCORING_TARGETS = ["driver", "constructor"] as const;
/** The calculations the scoring engine knows (HLD 5.6, DM 3.2). */
export const SCORING_RULE_KINDS = [
  "position_table",
  "positions_delta",
  "classification_penalty",
  "flag_bonus",
  "knockout_stage",
  "per_driver_penalty",
  "aggregate_drivers",
] as const;

/** DM 3.1: one playable game. */
export const games = pgTable(
  "games",
  {
    id: uuid("id").primaryKey(),
    seasonId: uuid("season_id")
      .notNull()
      .references(() => seasons.id, { onDelete: "restrict" }),
    gameType: text("game_type", { enum: GAME_TYPES }).notNull(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    status: text("status", { enum: GAME_STATUSES }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("games_season_id_game_type_unique").on(t.seasonId, t.gameType),
    check("games_game_type_check", oneOf(t.gameType, GAME_TYPES)),
    check("games_status_check", oneOf(t.status, GAME_STATUSES)),
  ],
);

/**
 * DM 3.2: the rules as versioned data. `params` is validated by
 * `rulesetParamsSchema` in application code. A version is frozen once an event
 * using it has locked (trigger).
 */
export const rulesetVersions = pgTable(
  "ruleset_versions",
  {
    id: uuid("id").primaryKey(),
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "restrict" }),
    version: integer("version").notNull(),
    /** Applies from this event's lock onwards, until a later version takes over. */
    effectiveFromEventId: uuid("effective_from_event_id")
      .notNull()
      .references(() => events.id, { onDelete: "restrict" }),
    params: jsonb("params").notNull(),
    /** What changed and why. Shown on the public rules page. */
    notes: text("notes").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("ruleset_versions_game_id_version_unique").on(t.gameId, t.version),
  ],
);

/**
 * DM 3.2: one scoring rule of a version. Its rows come in M4; M3 only needs
 * the table and the freeze.
 */
export const scoringRules = pgTable(
  "scoring_rules",
  {
    id: uuid("id").primaryKey(),
    // A rule is a true child of its version (DM 0.7).
    rulesetVersionId: uuid("ruleset_version_id")
      .notNull()
      .references(() => rulesetVersions.id, { onDelete: "cascade" }),
    /** Stable key such as `race.finish_position`. Score lines refer to it. */
    code: text("code").notNull(),
    sessionKind: text("session_kind", { enum: SESSION_KINDS }).notNull(),
    target: text("target", { enum: SCORING_TARGETS }).notNull(),
    kind: text("kind", { enum: SCORING_RULE_KINDS }).notNull(),
    /** The category No Negative floors at 0 (HLD 5.4). */
    category: text("category").notNull(),
    /** Validated per `kind` in application code. */
    params: jsonb("params").notNull(),
    /** Order on the score explanation. */
    sortOrder: integer("sort_order").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("scoring_rules_ruleset_version_id_code_unique").on(
      t.rulesetVersionId,
      t.code,
    ),
    check(
      "scoring_rules_session_kind_check",
      oneOf(t.sessionKind, SESSION_KINDS),
    ),
    check("scoring_rules_target_check", oneOf(t.target, SCORING_TARGETS)),
    check("scoring_rules_kind_check", oneOf(t.kind, SCORING_RULE_KINDS)),
  ],
);

/** DM 3.3: an event as the game sees it. */
export const gameEvents = pgTable(
  "game_events",
  {
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "restrict" }),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "restrict" }),
    /**
     * The event's order in this game, by `events.lock_at` over non-cancelled
     * events. Null for a cancelled event. Frozen once the event has locked.
     */
    sequence: integer("sequence"),
    status: text("status", { enum: GAME_EVENT_STATUSES }).notNull(),
    /** The version in force for this event. */
    rulesetVersionId: uuid("ruleset_version_id")
      .notNull()
      .references(() => rulesetVersions.id, { onDelete: "restrict" }),
    /** When this event's prices were published (DM 3.5). */
    pricesReadyAt: timestamp("prices_ready_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.gameId, t.eventId] }),
    check("game_events_status_check", oneOf(t.status, GAME_EVENT_STATUSES)),
  ],
);

/**
 * DM 3.3: a session the game doesn't score as normal, such as an abandoned
 * race the admins void (DM 3.9). One per session per game; setting and
 * clearing it are audited, and queue a re-score (`enqueueScoring`).
 */
export const gameSessionExceptions = pgTable(
  "game_session_exceptions",
  {
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "restrict" }),
    sessionId: uuid("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "restrict" }),
    policy: text("policy", { enum: SESSION_EXCEPTION_POLICIES }).notNull(),
    reason: text("reason").notNull(),
    // FK to users added in M5; who acted is in the audit row until then.
    decidedBy: uuid("decided_by").notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.gameId, t.sessionId] }),
    check(
      "game_session_exceptions_policy_check",
      oneOf(t.policy, SESSION_EXCEPTION_POLICIES),
    ),
  ],
);

/**
 * DM 3.4: what can be picked. The one ID the game layer uses for a driver or a
 * constructor, in picks, prices and score lines.
 */
export const poolAssets = pgTable(
  "pool_assets",
  {
    id: uuid("id").primaryKey(),
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "restrict" }),
    assetType: text("asset_type", { enum: POOL_ASSET_TYPES }).notNull(),
    driverId: uuid("driver_id").references(() => drivers.id, {
      onDelete: "restrict",
    }),
    constructorId: uuid("constructor_id").references(() => constructors.id, {
      onDelete: "restrict",
    }),
    /** `withdrawn` can't be bought, but owners keep it and its penalties. */
    status: text("status", { enum: POOL_ASSET_STATUSES }).notNull(),
    /** When it became pickable. */
    addedFromEventId: uuid("added_from_event_id")
      .notNull()
      .references(() => events.id, { onDelete: "restrict" }),
    withdrawnFromEventId: uuid("withdrawn_from_event_id").references(
      () => events.id,
      { onDelete: "restrict" },
    ),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("pool_assets_game_id_driver_id_unique").on(t.gameId, t.driverId),
    unique("pool_assets_game_id_constructor_id_unique").on(
      t.gameId,
      t.constructorId,
    ),
    check("pool_assets_asset_type_check", oneOf(t.assetType, POOL_ASSET_TYPES)),
    check("pool_assets_status_check", oneOf(t.status, POOL_ASSET_STATUSES)),
    // Exactly one of the two ids, the one the type names.
    check(
      "pool_assets_one_subject_check",
      sql`(${t.assetType} = 'driver' and ${t.driverId} is not null and ${t.constructorId} is null)
        or (${t.assetType} = 'constructor' and ${t.constructorId} is not null and ${t.driverId} is null)`,
    ),
  ],
);

/**
 * DM 3.5: one price update (`runPriceUpdate`): the prices it wrote for the
 * event after `after_event_id`, and why. `inputs` holds each asset's recent
 * points, average, ratio and tier, so every change can be shown working.
 */
export const priceUpdateRuns = pgTable("price_update_runs", {
  id: uuid("id").primaryKey(),
  gameId: uuid("game_id")
    .notNull()
    .references(() => games.id, { onDelete: "restrict" }),
  /** The event whose scores the update read; its prices are for the next one. */
  afterEventId: uuid("after_event_id")
    .notNull()
    .references(() => events.id, { onDelete: "restrict" }),
  /** The version in force for the event the prices are for. */
  rulesetVersionId: uuid("ruleset_version_id")
    .notNull()
    .references(() => rulesetVersions.id, { onDelete: "restrict" }),
  inputs: jsonb("inputs").notNull(),
  ranAt: timestamp("ran_at", { withTimezone: true }).notNull(),
  /** `system` for the job, or the staff login that ran it. */
  ranBy: text("ran_by").notNull(),
});

/**
 * DM 3.5: one price per asset per event, frozen once the event locks (trigger).
 * `run_id` is the update that wrote a `formula` price, null for the others.
 */
export const assetPrices = pgTable(
  "asset_prices",
  {
    assetId: uuid("asset_id")
      .notNull()
      .references(() => poolAssets.id, { onDelete: "restrict" }),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "restrict" }),
    /** Units of $0.1M. */
    price: integer("price").notNull(),
    source: text("source", { enum: PRICE_SOURCES }).notNull(),
    runId: uuid("run_id").references(() => priceUpdateRuns.id, {
      onDelete: "restrict",
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.assetId, t.eventId] }),
    check(
      "asset_prices_price_check",
      sql`${t.price} between ${sql.raw(String(PRICE_MIN))} and ${sql.raw(String(PRICE_MAX))}`,
    ),
    check("asset_prices_source_check", oneOf(t.source, PRICE_SOURCES)),
    // Only a formula price has a run.
    check(
      "asset_prices_run_id_check",
      sql`(${t.source} = 'formula') = (${t.runId} is not null)`,
    ),
    index("asset_prices_event_id_idx").on(t.eventId),
  ],
);

/**
 * DM 3.6: a user's team in a game. `user_id` is a plain uuid until `users`
 * arrives in M5, which adds the foreign key. `slot` runs from 1 to the
 * ruleset's `teamsPerUser` (trigger), and a retired team keeps its slot.
 */
export const teams = pgTable(
  "teams",
  {
    id: uuid("id").primaryKey(),
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "restrict" }),
    userId: uuid("user_id").notNull(),
    slot: smallint("slot").notNull(),
    name: text("name").notNull(),
    /**
     * The team's first locked event, set by the first lock it takes part in.
     * Null until then, and while null the team can be deleted outright.
     */
    firstEventId: uuid("first_event_id").references(() => events.id, {
      onDelete: "restrict",
    }),
    status: text("status", { enum: TEAM_STATUSES }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("teams_game_id_user_id_slot_unique").on(t.gameId, t.userId, t.slot),
    check("teams_status_check", oneOf(t.status, TEAM_STATUSES)),
    check(
      "teams_name_check",
      sql`char_length(${t.name}) between 1 and ${sql.raw(String(TEAM_NAME_MAX))}`,
    ),
    index("teams_user_id_idx").on(t.userId),
  ],
);

/**
 * DM 3.7: a saved lineup. Every save is a new row and none is changed. The
 * database sets `saved_at` from app_now() whatever the insert says, and checks
 * the window, the composition and the assets when the transaction commits
 * (triggers). Deleting a team deletes its versions.
 */
export const lineupVersions = pgTable(
  "lineup_versions",
  {
    id: uuid("id").primaryKey(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    /** The event whose window was open when it was saved. */
    forEventId: uuid("for_event_id")
      .notNull()
      .references(() => events.id, { onDelete: "restrict" }),
    kind: text("kind", { enum: LINEUP_KINDS }).notNull(),
    /** Only for `final_fix`: the race session it applies from. */
    effectiveFromSessionId: uuid("effective_from_session_id").references(
      () => sessions.id,
      { onDelete: "restrict" },
    ),
    /** The version the user was editing; it may no longer be the latest. */
    basedOnVersionId: uuid("based_on_version_id").references(
      (): AnyPgColumn => lineupVersions.id,
      { onDelete: "set null" },
    ),
    /** Set by the database (trigger); the default only lets an insert omit it. */
    savedAt: timestamp("saved_at", { withTimezone: true })
      .notNull()
      .default(sql`app_now()`),
  },
  (t) => [
    check("lineup_versions_kind_check", oneOf(t.kind, LINEUP_KINDS)),
    check(
      "lineup_versions_final_fix_session_check",
      sql`(${t.kind} = 'final_fix') = (${t.effectiveFromSessionId} is not null)`,
    ),
    index("lineup_versions_team_id_for_event_id_saved_at_idx").on(
      t.teamId,
      t.forEventId,
      t.savedAt.desc(),
    ),
    // One Late Call version per team per event: the chip allows one swap.
    uniqueIndex("lineup_versions_team_id_for_event_id_final_fix_unique")
      .on(t.teamId, t.forEventId)
      .where(sql`${t.kind} = 'final_fix'`),
  ],
);

/** DM 3.7: the assets of a version. The same asset can't be picked twice. */
export const lineupPicks = pgTable(
  "lineup_picks",
  {
    lineupVersionId: uuid("lineup_version_id")
      .notNull()
      .references(() => lineupVersions.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => poolAssets.id, { onDelete: "restrict" }),
    /** The 2x Boost: as many as the ruleset's `squad.boosts`, on drivers. */
    isBoost: boolean("is_boost").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.lineupVersionId, t.assetId] }),
    index("lineup_picks_asset_id_idx").on(t.assetId),
  ],
);

/**
 * DM 3.9: a chip played by a team for an event. The code is one of the event's
 * ruleset chips. The database stamps `played_at` from app_now(), and checks the
 * window, the unlock rule and the x3 Boost target when the transaction commits
 * (triggers). A play is never deleted or undone; only the system refunds one,
 * for a cancelled event. Deleting a team before its first lock deletes its
 * plays.
 */
export const chipPlays = pgTable(
  "chip_plays",
  {
    id: uuid("id").primaryKey(),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "restrict" }),
    chipCode: text("chip_code").notNull(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "restrict" }),
    /** The x3 Boost driver; only for that chip. */
    targetAssetId: uuid("target_asset_id").references(() => poolAssets.id, {
      onDelete: "restrict",
    }),
    /** Set by the database (trigger); the default only lets an insert omit it. */
    playedAt: timestamp("played_at", { withTimezone: true })
      .notNull()
      .default(sql`app_now()`),
    status: text("status", { enum: CHIP_PLAY_STATUSES }).notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("chip_plays_status_check", oneOf(t.status, CHIP_PLAY_STATUSES)),
    // Once per season, and one chip per race.
    uniqueIndex("chip_plays_team_id_chip_code_played_unique")
      .on(t.teamId, t.chipCode)
      .where(sql`${t.status} = 'played'`),
    uniqueIndex("chip_plays_team_id_event_id_played_unique")
      .on(t.teamId, t.eventId)
      .where(sql`${t.status} = 'played'`),
    // Scoring loads one event's chips at once.
    index("chip_plays_event_id_played_idx")
      .on(t.eventId)
      .where(sql`${t.status} = 'played'`),
  ],
);

/**
 * DM 3.8: one row per team per event it took part in, written by the lock job
 * (`lockEvent`) and never rewritten by it, except that a Late Call sets
 * `final_fix_version_id` and `chip_play_id` after the lock. Money is in units
 * of $0.1M. The bank is never below 0 outside a Limitless week; a CHECK can't
 * see the chip, so the lock job asserts it.
 */
export const teamEventStates = pgTable(
  "team_event_states",
  {
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "restrict" }),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "restrict" }),
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "restrict" }),
    /**
     * The lineup the transfers are counted against: the previous event's
     * locked one, or the one before a Limitless week. Null at the first event.
     */
    baseVersionId: uuid("base_version_id").references(() => lineupVersions.id, {
      onDelete: "restrict",
    }),
    /** What counts for this event. */
    lockedVersionId: uuid("locked_version_id")
      .notNull()
      .references(() => lineupVersions.id, { onDelete: "restrict" }),
    finalFixVersionId: uuid("final_fix_version_id").references(
      () => lineupVersions.id,
      { onDelete: "restrict" },
    ),
    /** The chip played for the event, if any. */
    chipPlayId: uuid("chip_play_id").references(() => chipPlays.id, {
      onDelete: "restrict",
    }),
    isFirstEvent: boolean("is_first_event").notNull(),
    /** Money available at this event's prices. */
    purchasingPower: integer("purchasing_power").notNull(),
    /** The locked lineup's cost at this event's prices. */
    spent: integer("spent").notNull(),
    /** `purchasing_power - spent`. */
    bank: integer("bank").notNull(),
    /** Assets in the locked lineup that aren't in the base. */
    transfersMade: integer("transfers_made").notNull(),
    /** This event's allowance with the carry-over in; null is unlimited. */
    freeTransfers: integer("free_transfers"),
    carryOverOut: smallint("carry_over_out").notNull(),
    /** Points, zero or less; the ledger copies it as its own line (Part 4). */
    transferPenalty: integer("transfer_penalty").notNull(),
    rulesetVersionId: uuid("ruleset_version_id")
      .notNull()
      .references(() => rulesetVersions.id, { onDelete: "restrict" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.teamId, t.eventId] }),
    index("team_event_states_event_id_idx").on(t.eventId),
  ],
);
