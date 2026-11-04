import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, oneOf, updatedAt } from "./helpers";
import { games, teams } from "./game";
import { constructors, drivers, events } from "./reference";

// Leagues and standings (DM 4.5 to 4.7). `owner_user_id` is a plain uuid until
// `users` arrives in M5, which adds the foreign key. Not declared here,
// because Drizzle cannot express them: the membership checks (the team is in
// the league's game, the source matches the kind) and the 50-league cap, which
// raises GL008. They live in the `league_rules` migration.

export const LEAGUE_KINDS = [
  "global",
  "public",
  "private",
  "auto_constructor",
  "auto_driver",
  "auto_country",
] as const;
export const LEAGUE_STATUSES = ["active", "archived"] as const;
/** `auto` covers the constructor, driver and country leagues (DM 4.6). */
export const MEMBERSHIP_SOURCES = ["user", "auto"] as const;
/** `final` once the through event is (DM 4.7). */
export const STANDING_STATUSES = ["provisional", "final"] as const;
/** A public or private league's name, in characters. */
export const LEAGUE_NAME_MAX = 40;
/** A team's `user` memberships at one time (DM 4.6). */
export const LEAGUE_CAP = 50;

/**
 * DM 4.5: the game's `global` league (one per game, created with it), the
 * user-made `public` and `private` ones, and one `auto_*` league per
 * constructor, driver or country, keyed by ID so a rebrand doesn't split it.
 * The range is event sequences, not rounds (DM 1.3, 3.3).
 */
export const leagues = pgTable(
  "leagues",
  {
    id: uuid("id").primaryKey(),
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "restrict" }),
    kind: text("kind", { enum: LEAGUE_KINDS }).notNull(),
    /** User content for public and private leagues (DM Part 5). */
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    ownerUserId: uuid("owner_user_id"),
    /** Public and private leagues only; random, from an alphabet with no look-alikes. */
    joinCode: text("join_code").unique(),
    /** Exactly one of these, matching the `auto_*` kind. */
    constructorId: uuid("constructor_id").references(() => constructors.id, {
      onDelete: "restrict",
    }),
    driverId: uuid("driver_id").references(() => drivers.id, {
      onDelete: "restrict",
    }),
    countryCode: text("country_code"),
    /** The range starts at this event sequence… */
    startSequence: integer("start_sequence").notNull().default(1),
    /** …and ends at this one. Null means to the end of the season. */
    endSequence: integer("end_sequence"),
    maxMembers: integer("max_members"),
    status: text("status", { enum: LEAGUE_STATUSES }).notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("leagues_game_id_slug_unique").on(t.gameId, t.slug),
    // Nulls are distinct, so these only bind the `auto_*` leagues.
    unique("leagues_game_id_kind_constructor_id_unique").on(
      t.gameId,
      t.kind,
      t.constructorId,
    ),
    unique("leagues_game_id_kind_driver_id_unique").on(
      t.gameId,
      t.kind,
      t.driverId,
    ),
    unique("leagues_game_id_kind_country_code_unique").on(
      t.gameId,
      t.kind,
      t.countryCode,
    ),
    uniqueIndex("leagues_game_id_global_unique")
      .on(t.gameId)
      .where(sql`${t.kind} = 'global'`),
    check("leagues_kind_check", oneOf(t.kind, LEAGUE_KINDS)),
    check("leagues_status_check", oneOf(t.status, LEAGUE_STATUSES)),
    // Exactly one key, matching the kind; none for the other kinds.
    check(
      "leagues_auto_key_check",
      sql`(${t.kind} = 'auto_constructor' and ${t.constructorId} is not null and ${t.driverId} is null and ${t.countryCode} is null)
        or (${t.kind} = 'auto_driver' and ${t.driverId} is not null and ${t.constructorId} is null and ${t.countryCode} is null)
        or (${t.kind} = 'auto_country' and ${t.countryCode} is not null and ${t.constructorId} is null and ${t.driverId} is null)
        or (${t.kind} in ('global', 'public', 'private') and ${t.constructorId} is null and ${t.driverId} is null and ${t.countryCode} is null)`,
    ),
    check(
      "leagues_country_code_check",
      sql`${t.countryCode} is null or ${t.countryCode} ~ '^[A-Z]{2,3}$'`,
    ),
    // Only user leagues have an owner, a code, a limit and a range of their own.
    check(
      "leagues_user_only_check",
      sql`${t.kind} in ('public', 'private')
        or (${t.ownerUserId} is null and ${t.joinCode} is null and ${t.maxMembers} is null
            and ${t.startSequence} = 1 and ${t.endSequence} is null)`,
    ),
    check(
      "leagues_name_check",
      sql`${t.kind} not in ('public', 'private')
        or char_length(${t.name}) between 1 and ${sql.raw(String(LEAGUE_NAME_MAX))}`,
    ),
    check(
      "leagues_range_check",
      sql`${t.startSequence} >= 1 and (${t.endSequence} is null or ${t.endSequence} >= ${t.startSequence})`,
    ),
    check(
      "leagues_max_members_check",
      sql`${t.maxMembers} is null or ${t.maxMembers} >= 1`,
    ),
  ],
);

/**
 * DM 4.6: a team's time in a league. Leaving sets `left_at` and rejoining
 * makes a new row. The `global` league has no rows. A team is in a league at
 * most once at a time. Deleting a team (one that never locked) deletes its
 * rows; a retired team keeps them.
 */
export const leagueMemberships = pgTable(
  "league_memberships",
  {
    id: uuid("id").primaryKey(),
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "restrict" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull(),
    leftAt: timestamp("left_at", { withTimezone: true }),
    source: text("source", { enum: MEMBERSHIP_SOURCES }).notNull(),
  },
  (t) => [
    check(
      "league_memberships_source_check",
      oneOf(t.source, MEMBERSHIP_SOURCES),
    ),
    check(
      "league_memberships_left_at_check",
      sql`${t.leftAt} is null or ${t.leftAt} >= ${t.joinedAt}`,
    ),
    // Its leading column also serves the DM 4.10 index on (league_id) where
    // left_at is null: a league's standings read its current members.
    uniqueIndex("league_memberships_league_id_team_id_active_unique")
      .on(t.leagueId, t.teamId)
      .where(sql`${t.leftAt} is null`),
    index("league_memberships_team_id_active_idx")
      .on(t.teamId)
      .where(sql`${t.leftAt} is null`),
  ],
);

/**
 * DM 4.7: the current table of each league, replaced by `recomputeStandings`
 * after every scoring run. A team that is not a current, active member has no
 * row.
 */
export const leagueStandings = pgTable(
  "league_standings",
  {
    leagueId: uuid("league_id")
      .notNull()
      .references(() => leagues.id, { onDelete: "restrict" }),
    teamId: uuid("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    /** Over the league's range, up to the through event. */
    points: integer("points").notNull(),
    /** The tiebreak, within the range: the earliest sequence at the total. */
    firstReachedSequence: integer("first_reached_sequence").notNull(),
    /** Shared on a full tie. */
    rank: integer("rank").notNull(),
    /** The rank at the previous through event, for the arrows. */
    previousRank: integer("previous_rank"),
    throughEventId: uuid("through_event_id")
      .notNull()
      .references(() => events.id, { onDelete: "restrict" }),
    status: text("status", { enum: STANDING_STATUSES }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.leagueId, t.teamId] }),
    check("league_standings_status_check", oneOf(t.status, STANDING_STATUSES)),
    check("league_standings_rank_check", sql`${t.rank} >= 1`),
    check(
      "league_standings_previous_rank_check",
      sql`${t.previousRank} is null or ${t.previousRank} >= 1`,
    ),
    check(
      "league_standings_first_reached_check",
      sql`${t.firstReachedSequence} >= 1`,
    ),
    index("league_standings_league_id_rank_idx").on(t.leagueId, t.rank),
  ],
);
