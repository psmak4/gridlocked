import { and, count, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import {
  constructors,
  drivers,
  LEAGUE_NAME_MAX,
  leagueMemberships,
  leagues,
  teams,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { GameError, isUniqueViolation, refusal } from "@/game/errors";
import { newId } from "@/lib/ids";

// Leagues and their members (DM 4.5, 4.6). `public` and `private` leagues are
// made and joined by users; the `auto_*` ones follow a profile; the `global`
// league is made with the game and has no members. Reads reference data and
// teams, never writes them (DM 0.5).

type AutoKind = "auto_constructor" | "auto_driver" | "auto_country";

/** No I, L, O, 0 or 1: nothing to mistake when a code is read out or typed. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 10;
const SLUG_SUFFIX_LENGTH = 6;
/** Tries at a join code before giving up: a collision is rare, never likely twice. */
const CODE_ATTEMPTS = 5;

/**
 * `length` characters from the alphabet, from `crypto.getRandomValues`. A byte
 * past the last whole multiple of the alphabet is thrown away, so no letter is
 * likelier than another.
 */
function randomText(length: number, alphabet = CODE_ALPHABET): string {
  const limit = 256 - (256 % alphabet.length);
  let text = "";
  while (text.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte < limit && text.length < length) {
        text += alphabet[byte % alphabet.length];
      }
    }
  }
  return text;
}

/** A new join code: `CODE_LENGTH` characters of `CODE_ALPHABET`. */
export function newJoinCode(): string {
  return randomText(CODE_LENGTH);
}

/** Lowercase words joined by hyphens, with accents dropped. */
function slugify(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Creates a `public` or `private` league for a game, `active`, and returns its
 * ID and join code. Both kinds get a code, so a public league can be shared
 * too. The slug is the name plus a random suffix, so two leagues can share a
 * name; it is not made from the code, which is a secret for a private league.
 * The range is the event sequences `startSequence` (default 1) to
 * `endSequence` (default: the end of the season), and `maxMembers` is
 * optional. A code or slug that collides is retried with new random parts.
 * Refused when the trimmed name is not 1 to 40 characters (`bad_name`); a bad
 * range or limit throws.
 */
export async function createLeague(
  db: Db,
  now: Date,
  input: {
    gameId: string;
    ownerUserId: string;
    kind: "public" | "private";
    name: string;
    startSequence?: number;
    endSequence?: number;
    maxMembers?: number;
  },
): Promise<{ leagueId: string; joinCode: string }> {
  const name = input.name.trim();
  const length = Array.from(name).length;
  if (length < 1 || length > LEAGUE_NAME_MAX) {
    throw new GameError(
      "bad_name",
      `a league name is 1 to ${LEAGUE_NAME_MAX} characters`,
    );
  }
  const startSequence = input.startSequence ?? 1;
  const endSequence = input.endSequence ?? null;
  const maxMembers = input.maxMembers ?? null;
  if (!Number.isInteger(startSequence) || startSequence < 1) {
    throw new Error(`createLeague: start ${startSequence} is not 1 or more`);
  }
  if (
    endSequence !== null &&
    (!Number.isInteger(endSequence) || endSequence < startSequence)
  ) {
    throw new Error(
      `createLeague: end ${endSequence} is before start ${startSequence}`,
    );
  }
  if (
    maxMembers !== null &&
    (!Number.isInteger(maxMembers) || maxMembers < 1)
  ) {
    throw new Error(`createLeague: limit ${maxMembers} is not 1 or more`);
  }

  for (let attempt = 1; ; attempt++) {
    const leagueId = newId();
    const joinCode = newJoinCode();
    const slug = `${slugify(name) || "league"}-${randomText(SLUG_SUFFIX_LENGTH, CODE_ALPHABET.toLowerCase())}`;
    try {
      await db.insert(leagues).values({
        id: leagueId,
        gameId: input.gameId,
        kind: input.kind,
        name,
        slug,
        ownerUserId: input.ownerUserId,
        joinCode,
        startSequence,
        endSequence,
        maxMembers,
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      return { leagueId, joinCode };
    } catch (error) {
      if (!isUniqueViolation(error) || attempt >= CODE_ATTEMPTS) throw error;
    }
  }
}

/**
 * Puts a team in the `public` or `private` league with this join code (any
 * case), as a `user` membership, and returns the league and the membership.
 * Refused:
 * - `team_not_owned`: the team is not `userId`'s;
 * - `league_not_found`: no active public or private league has the code, or it
 *   is another game's. An auto league has no code and is not joined by hand;
 * - `already_member`: the team is in the league now;
 * - `league_full`: the league has `max_members` current members;
 * - `league_cap`: the team is in 50 `user` leagues (the database, GL008).
 * The league row is held, so joins to one league take turns and a limit holds.
 */
export async function joinLeague(
  db: Db,
  now: Date,
  input: { joinCode: string; teamId: string; userId: string },
): Promise<{ leagueId: string; membershipId: string }> {
  try {
    return await db.transaction(async (tx) => {
      const team = await ownedTeam(tx, input);
      const [league] = await tx
        .select()
        .from(leagues)
        .where(eq(leagues.joinCode, input.joinCode.trim().toUpperCase()))
        .for("update");
      if (
        !league ||
        league.status !== "active" ||
        league.gameId !== team.gameId
      ) {
        throw new GameError(
          "league_not_found",
          "there is no league with that code",
        );
      }

      const [current] = await tx
        .select({ id: leagueMemberships.id })
        .from(leagueMemberships)
        .where(
          and(
            eq(leagueMemberships.leagueId, league.id),
            eq(leagueMemberships.teamId, team.id),
            isNull(leagueMemberships.leftAt),
          ),
        );
      if (current) {
        throw new GameError(
          "already_member",
          "that team is in the league already",
        );
      }
      if (league.maxMembers !== null) {
        const [counted] = await tx
          .select({ members: count() })
          .from(leagueMemberships)
          .where(
            and(
              eq(leagueMemberships.leagueId, league.id),
              isNull(leagueMemberships.leftAt),
            ),
          );
        if ((counted?.members ?? 0) >= league.maxMembers) {
          throw new GameError("league_full", "that league is full");
        }
      }

      const membershipId = newId();
      await tx.insert(leagueMemberships).values({
        id: membershipId,
        leagueId: league.id,
        teamId: team.id,
        joinedAt: now,
        leftAt: null,
        source: "user",
      });
      return { leagueId: league.id, membershipId };
    });
  } catch (error) {
    throw refusal(error);
  }
}

/**
 * Takes a team out of a `public` or `private` league: its current membership
 * gets `left_at`, and joining again makes a new row, so the history stays.
 * Refused: `team_not_owned` when the team is not `userId`'s, and
 * `league_not_found` when the league is not one a team leaves by hand (the
 * global and auto leagues follow the profile) or the team is not in it.
 */
export async function leaveLeague(
  db: Db,
  now: Date,
  input: { leagueId: string; teamId: string; userId: string },
): Promise<void> {
  await db.transaction(async (tx) => {
    const team = await ownedTeam(tx, input);
    const left = await tx
      .update(leagueMemberships)
      .set({ leftAt: now })
      .where(
        and(
          eq(leagueMemberships.leagueId, input.leagueId),
          eq(leagueMemberships.teamId, team.id),
          eq(leagueMemberships.source, "user"),
          isNull(leagueMemberships.leftAt),
        ),
      )
      .returning({ id: leagueMemberships.id });
    if (left.length === 0) {
      throw new GameError(
        "league_not_found",
        "that team is not in that league",
      );
    }
  });
}

/** The team, if it is `userId`'s; `team_not_owned` for another's or none. */
async function ownedTeam(
  tx: Db,
  input: { teamId: string; userId: string },
): Promise<typeof teams.$inferSelect> {
  const [team] = await tx
    .select()
    .from(teams)
    .where(eq(teams.id, input.teamId));
  if (!team || team.userId !== input.userId) {
    throw new GameError("team_not_owned", "that team is not yours");
  }
  return team;
}

/**
 * Moves every active team of a user in a game into the auto leagues of their
 * profile (DM 4.6), for each key that is not null: the favorite constructor,
 * the favorite driver and the country. A league is created when the game has
 * none for the key yet. A team leaves the auto leagues of a kind that no
 * longer match, and a null key means no league of that kind. Memberships are
 * `auto`, joined and left at `now`; running it again changes nothing. A team
 * created later is moved in by running it again. Leagues are keyed by the
 * constructor or driver ID or the country code, never by name, so a rebrand
 * keeps the league. A country code is upper-cased; one that is not 2 or 3
 * letters throws, as does an ID with no row.
 */
export async function syncAutoLeagues(
  db: Db,
  now: Date,
  input: {
    userId: string;
    gameId: string;
    constructorId: string | null;
    driverId: string | null;
    countryCode: string | null;
  },
): Promise<void> {
  const countryCode = input.countryCode?.trim().toUpperCase() ?? null;
  if (countryCode !== null && !/^[A-Z]{2,3}$/.test(countryCode)) {
    throw new Error(`syncAutoLeagues: bad country code ${input.countryCode}`);
  }
  const wanted: { kind: AutoKind; key: string | null }[] = [
    { kind: "auto_constructor", key: input.constructorId },
    { kind: "auto_driver", key: input.driverId },
    { kind: "auto_country", key: countryCode },
  ];

  await db.transaction(async (tx) => {
    // One user's syncs take turns, so two can't both create a missing league
    // for their teams' sake or move a team twice.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`auto_leagues:${input.userId}:${input.gameId}`}, 0))`,
    );
    const teamIds = (
      await tx
        .select({ id: teams.id })
        .from(teams)
        .where(
          and(
            eq(teams.gameId, input.gameId),
            eq(teams.userId, input.userId),
            eq(teams.status, "active"),
          ),
        )
    ).map((team) => team.id);
    if (teamIds.length === 0) return;

    for (const { kind, key } of wanted) {
      const leagueId =
        key === null
          ? null
          : await autoLeague(tx, now, input.gameId, kind, key);

      // Out of the auto leagues of this kind that are not the one wanted.
      await tx
        .update(leagueMemberships)
        .set({ leftAt: now })
        .where(
          and(
            inArray(leagueMemberships.teamId, teamIds),
            isNull(leagueMemberships.leftAt),
            leagueId === null
              ? undefined
              : ne(leagueMemberships.leagueId, leagueId),
            inArray(
              leagueMemberships.leagueId,
              tx
                .select({ id: leagues.id })
                .from(leagues)
                .where(
                  and(eq(leagues.gameId, input.gameId), eq(leagues.kind, kind)),
                ),
            ),
          ),
        );
      if (leagueId === null) continue;

      const members = new Set(
        (
          await tx
            .select({ teamId: leagueMemberships.teamId })
            .from(leagueMemberships)
            .where(
              and(
                eq(leagueMemberships.leagueId, leagueId),
                inArray(leagueMemberships.teamId, teamIds),
                isNull(leagueMemberships.leftAt),
              ),
            )
        ).map((row) => row.teamId),
      );
      const joining = teamIds.filter((id) => !members.has(id));
      if (joining.length > 0) {
        await tx.insert(leagueMemberships).values(
          joining.map((teamId) => ({
            id: newId(),
            leagueId,
            teamId,
            joinedAt: now,
            leftAt: null,
            source: "auto" as const,
          })),
        );
      }
    }
  });
}

/**
 * The game's auto league of a kind for a key (a constructor ID, a driver ID or
 * a country code), created on first use. The unique key makes two creates for
 * one key race: the loser's insert does nothing and finds the winner's row.
 */
async function autoLeague(
  tx: Db,
  now: Date,
  gameId: string,
  kind: AutoKind,
  key: string,
): Promise<string> {
  const column = {
    auto_constructor: leagues.constructorId,
    auto_driver: leagues.driverId,
    auto_country: leagues.countryCode,
  }[kind];
  const find = async () => {
    const [found] = await tx
      .select({ id: leagues.id })
      .from(leagues)
      .where(
        and(
          eq(leagues.gameId, gameId),
          eq(leagues.kind, kind),
          eq(column, key),
        ),
      );
    return found?.id;
  };
  const existing = await find();
  if (existing) return existing;

  const names = await autoLeagueNames(tx, kind, key);
  await tx
    .insert(leagues)
    .values({
      id: newId(),
      gameId,
      kind,
      name: names.name,
      slug: names.slug,
      constructorId: kind === "auto_constructor" ? key : null,
      driverId: kind === "auto_driver" ? key : null,
      countryCode: kind === "auto_country" ? key : null,
      status: "active",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  const created = await find();
  if (!created) {
    throw new Error(
      `syncAutoLeagues: no ${kind} league for ${key} in ${gameId}`,
    );
  }
  return created;
}

/** The name and slug a new auto league gets: "Ferrari fans". */
async function autoLeagueNames(
  tx: Db,
  kind: AutoKind,
  key: string,
): Promise<{ name: string; slug: string }> {
  if (kind === "auto_constructor") {
    const [row] = await tx
      .select({ name: constructors.name, slug: constructors.slug })
      .from(constructors)
      .where(eq(constructors.id, key));
    if (!row) throw new Error(`syncAutoLeagues: no constructor ${key}`);
    return { name: `${row.name} fans`, slug: `constructor-${row.slug}` };
  }
  if (kind === "auto_driver") {
    const [row] = await tx
      .select({
        displayName: drivers.displayName,
        givenName: drivers.givenName,
        familyName: drivers.familyName,
        slug: drivers.slug,
      })
      .from(drivers)
      .where(eq(drivers.id, key));
    if (!row) throw new Error(`syncAutoLeagues: no driver ${key}`);
    const name = row.displayName ?? `${row.givenName} ${row.familyName}`;
    return { name: `${name} fans`, slug: `driver-${row.slug}` };
  }
  let country = key;
  try {
    country = new Intl.DisplayNames(["en"], { type: "region" }).of(key) ?? key;
  } catch {
    // Not a region the runtime knows: the code stands in for the name.
  }
  return { name: `${country} fans`, slug: `country-${key.toLowerCase()}` };
}
