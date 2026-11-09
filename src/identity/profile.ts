/**
 * The profile a user edits (DM 6.2): favorites, country, timezone and spoiler
 * protection. A favorite or the country also decides which auto leagues the
 * user's teams are in (DM 4.6).
 */
import { and, eq, sql } from "drizzle-orm";
import { games, poolAssets, profiles } from "@/db/schema";
import type { Db } from "@/db/types";
import { syncAutoLeagues } from "@/leagues/leagues";
import { IdentityError } from "./viewer";

export type ProfileUpdate = {
  userId: string;
  /** The `profiles.version` the form was loaded with (DM 0.7). */
  expectedVersion: number;
  /** `undefined` leaves a field alone; `null` clears a favorite or the country. */
  favoriteConstructorId?: string | null;
  favoriteDriverId?: string | null;
  countryCode?: string | null;
  timezone?: string;
  spoilerProtection?: boolean;
};

const regions = new Intl.DisplayNames(["en"], {
  type: "region",
  fallback: "none",
});

/**
 * Retired ISO 3166 codes. Some runtimes' ICU data (Vercel's Node) still names
 * them, so they would show up twice in the list (UK next to GB) and be
 * accepted. Ruling 57.
 */
export const RETIRED_REGION_CODES: ReadonlySet<string> = new Set([
  "AN",
  "BU",
  "CS",
  "DD",
  "DY",
  "FX",
  "HV",
  "NH",
  "NT",
  "QU",
  "RH",
  "SU",
  "TP",
  "UK",
  "VD",
  "YD",
  "YU",
  "ZR",
]);

/**
 * Codes that CLDR names but that aren't countries a person lives in: unions,
 * pseudo-locales, reserved and exceptionally reserved codes. A country league
 * named after one ("European Union fans") would be nonsense.
 */
export const NOT_COUNTRIES: ReadonlySet<string> = new Set([
  "AC",
  "CP",
  "DG",
  "EA",
  "EU",
  "EZ",
  "IC",
  "QO",
  "TA",
  "UN",
  "XA",
  "XB",
  "ZZ",
]);

/**
 * The upper-cased ISO 3166-1 alpha-2 code, or null when it is not one: two
 * letters that the runtime's CLDR region data knows, that are not retired and
 * that name a country (Ruling 58: the server refuses what the list leaves out).
 */
export function normalizeCountryCode(raw: string): string | null {
  const code = raw.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return null;
  if (RETIRED_REGION_CODES.has(code) || NOT_COUNTRIES.has(code)) return null;
  if (regions.of(code) === undefined) return null;
  return code;
}

function isTimezone(name: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/**
 * Saves the profile fields given, if the profile is still at `expectedVersion`
 * (a compare-and-set that adds 1), otherwise `version_conflict`. When a
 * favorite or the country changed, moves the user's teams in every running
 * game into the right auto leagues. A favorite constructor the game doesn't
 * have gets no constructor league there.
 */
export async function updateProfile(
  db: Db,
  now: Date,
  input: ProfileUpdate,
): Promise<void> {
  let countryCode: string | null | undefined = input.countryCode;
  if (typeof countryCode === "string") {
    const normalized = normalizeCountryCode(countryCode);
    if (normalized === null) throw new IdentityError("invalid_country");
    countryCode = normalized;
  }
  if (input.timezone !== undefined && !isTimezone(input.timezone)) {
    throw new IdentityError("invalid_timezone");
  }

  const set: Partial<typeof profiles.$inferInsert> = {};
  if (input.favoriteConstructorId !== undefined) {
    set.favoriteConstructorId = input.favoriteConstructorId;
  }
  if (input.favoriteDriverId !== undefined) {
    set.favoriteDriverId = input.favoriteDriverId;
  }
  if (countryCode !== undefined) set.countryCode = countryCode;
  if (input.timezone !== undefined) set.timezone = input.timezone;
  if (input.spoilerProtection !== undefined) {
    set.spoilerProtection = input.spoilerProtection;
  }

  // The compare-and-set and the league sync are one transaction: the profile
  // row lock queues two saves, and a failed sync rolls the save back.
  await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const [before] = await t
      .select()
      .from(profiles)
      .where(eq(profiles.userId, input.userId));
    if (!before) throw new IdentityError("unauthenticated");

    const [after] = await t
      .update(profiles)
      .set({ ...set, updatedAt: now, version: sql`${profiles.version} + 1` })
      .where(
        and(
          eq(profiles.userId, input.userId),
          eq(profiles.version, input.expectedVersion),
        ),
      )
      .returning();
    if (!after) throw new IdentityError("version_conflict");

    const leaguesChanged =
      after.favoriteConstructorId !== before.favoriteConstructorId ||
      after.favoriteDriverId !== before.favoriteDriverId ||
      after.countryCode !== before.countryCode;
    if (!leaguesChanged) return;

    const running = await t
      .select({ id: games.id })
      .from(games)
      .where(eq(games.status, "running"));
    for (const game of running) {
      const constructorId =
        after.favoriteConstructorId !== null &&
        (await gameHasConstructor(t, game.id, after.favoriteConstructorId))
          ? after.favoriteConstructorId
          : null;
      await syncAutoLeagues(t, now, {
        userId: input.userId,
        gameId: game.id,
        constructorId,
        driverId: after.favoriteDriverId,
        countryCode: after.countryCode,
      });
    }
  });
}

async function gameHasConstructor(
  db: Db,
  gameId: string,
  constructorId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: poolAssets.id })
    .from(poolAssets)
    .where(
      and(
        eq(poolAssets.gameId, gameId),
        eq(poolAssets.constructorId, constructorId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * True when the user has a favorite constructor that `gameId` doesn't have, so
 * settings can ask them to pick again (DM 6.11). The favorite itself stays on
 * the profile as flair.
 */
export async function favoriteIsStale(
  db: Db,
  userId: string,
  gameId: string,
): Promise<boolean> {
  const [profile] = await db
    .select({ favorite: profiles.favoriteConstructorId })
    .from(profiles)
    .where(eq(profiles.userId, userId));
  if (!profile?.favorite) return false;
  return !(await gameHasConstructor(db, gameId, profile.favorite));
}
