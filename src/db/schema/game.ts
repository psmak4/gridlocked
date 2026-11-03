import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, oneOf, updatedAt } from "./helpers";
import {
  constructors,
  drivers,
  events,
  seasons,
  SESSION_KINDS,
} from "./reference";

// The fantasy core (DM Part 3): game data. It points down at reference data
// and never the other way (DM 0.5). IDs are UUIDv7 values supplied by the app.
//
// Not declared here, because Drizzle cannot express it: the freeze trigger on
// ruleset_versions and scoring_rules (DM 3.2), and the price freeze on
// asset_prices (DM 3.5). They live in the `game_rules` and `game_rules_2`
// migrations.

export const GAME_TYPES = ["season_fantasy"] as const;
export const GAME_STATUSES = ["setup", "open", "running", "completed"] as const;
/** `scored` and `final` are used from M4; M3 moves events through the rest. */
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
/** `formula` is written by the price update (M4). */
export const PRICE_SOURCES = [
  "initial",
  "formula",
  "admin",
  "carried",
] as const;
/** Prices are in units of $0.1M: $3.0M to $34.0M (DM 3.5). */
export const PRICE_MIN = 30;
export const PRICE_MAX = 340;
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
 * DM 3.5: one price per asset per event, frozen once the event locks (trigger).
 * `run_id` comes in M4, with `price_update_runs`.
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
    index("asset_prices_event_id_idx").on(t.eventId),
  ],
);
