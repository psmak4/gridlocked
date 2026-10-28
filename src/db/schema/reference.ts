import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { createdAt, oneOf, updatedAt } from "./helpers";

// Reference data (DM Part 1): the real-world calendar and line-up. No game
// logic lives here. IDs are UUIDv7 values supplied by the app (`newId()`), so
// no column has a database default for them.
//
// Not declared here, because Drizzle cannot express them: the DEFERRABLE
// unique on events (season_id, round) and the two GiST exclusion constraints on
// seat_assignments. They live in the `reference_constraints` migration.

export const SEASON_STATUSES = ["upcoming", "active", "completed"] as const;
export const EVENT_FORMATS = ["standard", "sprint"] as const;
export const EVENT_STATUSES = ["scheduled", "cancelled", "completed"] as const;
export const SOURCES_DEFAULT_OR_ADMIN = ["default", "admin"] as const;
export const SESSION_KINDS = [
  "fp1",
  "fp2",
  "fp3",
  "sprint_qualifying",
  "sprint",
  "qualifying",
  "race",
] as const;
export const SESSION_STATUSES = [
  "scheduled",
  "live",
  "suspended",
  "completed",
  "abandoned",
  "cancelled",
] as const;
export const TIME_SOURCES = ["provider", "admin"] as const;
export const SEAT_ROLES = ["race", "reserve"] as const;
export const EVENT_ENTRY_SOURCES = ["seat", "admin", "results"] as const;
export const AVAILABILITY_STATUSES = [
  "available",
  "doubtful",
  "unavailable",
  "reserve",
] as const;
export const AVAILABILITY_SOURCES = [
  "default",
  "roster_check",
  "admin",
] as const;
export const PROVIDER_ENTITY_TYPES = [
  "circuit",
  "event",
  "session",
  "driver",
  "constructor",
] as const;

/** DM 1.1 */
export const seasons = pgTable(
  "seasons",
  {
    id: uuid("id").primaryKey(),
    year: integer("year").notNull().unique(),
    status: text("status", { enum: SEASON_STATUSES }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check("seasons_status_check", oneOf(t.status, SEASON_STATUSES))],
);

/** DM 1.2 */
export const circuits = pgTable("circuits", {
  id: uuid("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  locality: text("locality").notNull(),
  country: text("country").notNull(),
  latitude: numeric("latitude", { precision: 9, scale: 6 }).notNull(),
  longitude: numeric("longitude", { precision: 9, scale: 6 }).notNull(),
  /** IANA zone, e.g. `Europe/Monaco`. */
  timezone: text("timezone").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** DM 1.3: a race weekend. */
export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey(),
    seasonId: uuid("season_id")
      .notNull()
      .references(() => seasons.id, { onDelete: "restrict" }),
    /** Display order only. Unique per season (deferrable; see the header). */
    round: integer("round").notNull(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    circuitId: uuid("circuit_id")
      .notNull()
      .references(() => circuits.id, { onDelete: "restrict" }),
    format: text("format", { enum: EVENT_FORMATS }).notNull(),
    status: text("status", { enum: EVENT_STATUSES }).notNull(),
    /**
     * The session whose start locks the game. Nullable and filled in after the
     * event's sessions exist (events and sessions reference each other).
     */
    lockSessionId: uuid("lock_session_id").references(
      (): AnyPgColumn => sessions.id,
      { onDelete: "restrict" },
    ),
    /** The fantasy lock (HLD 5.2). */
    lockAt: timestamp("lock_at", { withTimezone: true }).notNull(),
    lockAtSource: text("lock_at_source", {
      enum: SOURCES_DEFAULT_OR_ADMIN,
    }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("events_format_check", oneOf(t.format, EVENT_FORMATS)),
    check("events_status_check", oneOf(t.status, EVENT_STATUSES)),
    check(
      "events_lock_at_source_check",
      oneOf(t.lockAtSource, SOURCES_DEFAULT_OR_ADMIN),
    ),
    index("events_season_id_lock_at_idx").on(t.seasonId, t.lockAt),
  ],
);

/** DM 1.4 */
export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "restrict" }),
    kind: text("kind", { enum: SESSION_KINDS }).notNull(),
    sequence: smallint("sequence").notNull().default(1),
    scheduledStart: timestamp("scheduled_start", {
      withTimezone: true,
    }).notNull(),
    /** False while only a date is known. */
    startConfirmed: boolean("start_confirmed").notNull(),
    scheduledEnd: timestamp("scheduled_end", { withTimezone: true }).notNull(),
    timeSource: text("time_source", { enum: TIME_SOURCES }).notNull(),
    status: text("status", { enum: SESSION_STATUSES }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("sessions_event_id_kind_sequence_unique").on(
      t.eventId,
      t.kind,
      t.sequence,
    ),
    check("sessions_kind_check", oneOf(t.kind, SESSION_KINDS)),
    check("sessions_time_source_check", oneOf(t.timeSource, TIME_SOURCES)),
    check("sessions_status_check", oneOf(t.status, SESSION_STATUSES)),
    index("sessions_scheduled_start_idx").on(t.scheduledStart),
  ],
);

/** DM 1.5: one row per person, whatever team they drive for. */
export const drivers = pgTable("drivers", {
  id: uuid("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  givenName: text("given_name").notNull(),
  familyName: text("family_name").notNull(),
  displayName: text("display_name"),
  /** `VER`. Not unique: codes are reused across eras. */
  code: text("code"),
  /** Not unique across history. A season's number lives on the seat. */
  permanentNumber: integer("permanent_number"),
  nationality: text("nationality").notNull(),
  dateOfBirth: date("date_of_birth", { mode: "string" }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** DM 1.6 */
export const constructors = pgTable("constructors", {
  id: uuid("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  nationality: text("nationality").notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** DM 1.7: how a constructor appears in one season. */
export const constructorSeasons = pgTable(
  "constructor_seasons",
  {
    constructorId: uuid("constructor_id")
      .notNull()
      .references(() => constructors.id, { onDelete: "restrict" }),
    seasonId: uuid("season_id")
      .notNull()
      .references(() => seasons.id, { onDelete: "restrict" }),
    displayName: text("display_name").notNull(),
    shortName: text("short_name").notNull(),
    /** `#RRGGBB`, an accent color only. */
    color: text("color").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({
      name: "constructor_seasons_pkey",
      columns: [t.constructorId, t.seasonId],
    }),
    check(
      "constructor_seasons_color_check",
      sql`${t.color} ~ '^#[0-9A-Fa-f]{6}$'`,
    ),
  ],
);

/**
 * DM 1.8: the expected line-up over a date range. The two exclusion
 * constraints on race seats live in the `reference_constraints` migration.
 */
export const seatAssignments = pgTable(
  "seat_assignments",
  {
    id: uuid("id").primaryKey(),
    seasonId: uuid("season_id")
      .notNull()
      .references(() => seasons.id, { onDelete: "restrict" }),
    driverId: uuid("driver_id")
      .notNull()
      .references(() => drivers.id, { onDelete: "restrict" }),
    constructorId: uuid("constructor_id")
      .notNull()
      .references(() => constructors.id, { onDelete: "restrict" }),
    carNumber: integer("car_number").notNull(),
    role: text("role", { enum: SEAT_ROLES }).notNull(),
    /** First day this seat applies. */
    validFrom: date("valid_from", { mode: "string" }).notNull(),
    /** Last day this seat applies, inclusive. Null means until further notice. */
    validTo: date("valid_to", { mode: "string" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("seat_assignments_role_check", oneOf(t.role, SEAT_ROLES)),
    check(
      "seat_assignments_valid_range_check",
      sql`${t.validTo} is null or ${t.validTo} >= ${t.validFrom}`,
    ),
    index("seat_assignments_season_id_constructor_id_idx").on(
      t.seasonId,
      t.constructorId,
    ),
  ],
);

/** DM 1.9: who is expected at this event. */
export const eventEntries = pgTable(
  "event_entries",
  {
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "restrict" }),
    driverId: uuid("driver_id")
      .notNull()
      .references(() => drivers.id, { onDelete: "restrict" }),
    constructorId: uuid("constructor_id")
      .notNull()
      .references(() => constructors.id, { onDelete: "restrict" }),
    carNumber: integer("car_number").notNull(),
    source: text("source", { enum: EVENT_ENTRY_SOURCES }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({
      name: "event_entries_pkey",
      columns: [t.eventId, t.driverId],
    }),
    check("event_entries_source_check", oneOf(t.source, EVENT_ENTRY_SOURCES)),
  ],
);

/** DM 1.10: real-world status of pool drivers. Never read by scoring. */
export const driverAvailability = pgTable(
  "driver_availability",
  {
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "restrict" }),
    driverId: uuid("driver_id")
      .notNull()
      .references(() => drivers.id, { onDelete: "restrict" }),
    status: text("status", { enum: AVAILABILITY_STATUSES })
      .notNull()
      .default("available"),
    reason: text("reason"),
    source: text("source", { enum: AVAILABILITY_SOURCES })
      .notNull()
      .default("default"),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({
      name: "driver_availability_pkey",
      columns: [t.eventId, t.driverId],
    }),
    check(
      "driver_availability_status_check",
      oneOf(t.status, AVAILABILITY_STATUSES),
    ),
    check(
      "driver_availability_source_check",
      oneOf(t.source, AVAILABILITY_SOURCES),
    ),
  ],
);

/**
 * DM 1.11: the provider key map. Only `src/providers/**` reads it. `entity_id`
 * points at a different table depending on `entity_type`, so it has no foreign
 * key (a deliberate exception, DM 1.11).
 */
export const providerIds = pgTable(
  "provider_ids",
  {
    provider: text("provider").notNull(),
    entityType: text("entity_type", { enum: PROVIDER_ENTITY_TYPES }).notNull(),
    providerKey: text("provider_key").notNull(),
    entityId: uuid("entity_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({
      name: "provider_ids_pkey",
      columns: [t.provider, t.entityType, t.providerKey],
    }),
    unique("provider_ids_provider_entity_type_entity_id_unique").on(
      t.provider,
      t.entityType,
      t.entityId,
    ),
    check(
      "provider_ids_entity_type_check",
      oneOf(t.entityType, PROVIDER_ENTITY_TYPES),
    ),
  ],
);
