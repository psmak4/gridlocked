/**
 * What the sign-up and onboarding server functions do (`account.ts` wraps
 * each in a Zod-checked `createServerFn`). Kept apart so the logic can be
 * tested on a database without the Start runtime.
 */
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  constructors,
  constructorSeasons,
  drivers,
  games,
  poolAssets,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { completeSignUp } from "@/identity/consent";
import { emailAllowance } from "@/identity/email/outbox";
import { normalizeCountryCode, updateProfile } from "@/identity/profile";
import { checkUsername, type UsernameProblem } from "@/identity/usernames";
import {
  IdentityError,
  requireViewer,
  requireWritable,
  type Viewer,
} from "@/identity/viewer";

export type AccountError =
  | UsernameProblem
  | "username_required"
  | "version_conflict"
  | "invalid_country"
  | "invalid_choice";

export type ActionResult<T extends object = object> =
  ({ ok: true } & T) | { ok: false; error: AccountError };

const ACCOUNT_ERRORS: readonly string[] = [
  "format",
  "reserved",
  "held",
  "taken",
  "version_conflict",
  "invalid_country",
] satisfies AccountError[];

/** The refusals a form can show; anything else is a real fault and rethrown. */
function refusal(error: unknown): { ok: false; error: AccountError } {
  if (error instanceof IdentityError && ACCOUNT_ERRORS.includes(error.code)) {
    return { ok: false, error: error.code as AccountError };
  }
  throw error;
}

// --- Finish signing up ------------------------------------------------------

export const finishSignUpInput = z.object({
  username: z.string().min(1).max(64).optional(),
  ageConfirmed: z.literal(true),
  accepted: z.literal(true),
});
export type FinishSignUpInput = z.infer<typeof finishSignUpInput>;

/** Records the two boxes and, when there is none yet, the username. */
export async function finishSignUpAction(
  db: Db,
  now: Date,
  viewer: Viewer | null,
  input: FinishSignUpInput,
): Promise<ActionResult> {
  const v = requireViewer(viewer);
  if (v.username === null && input.username === undefined) {
    return { ok: false, error: "username_required" };
  }
  try {
    await completeSignUp(db, now, {
      userId: v.userId,
      ageConfirmed: true,
      accepted: true,
      ...(input.username !== undefined ? { username: input.username } : {}),
    });
    return { ok: true };
  } catch (error) {
    return refusal(error);
  }
}

// --- Favorites and spoilers -------------------------------------------------

export type FavoriteChoices = {
  constructors: { id: string; name: string; color: string }[];
  drivers: { id: string; name: string }[];
};

/** What the running game(s) can be favored from: its pool, by name. */
export async function favoriteChoices(db: Db): Promise<FavoriteChoices> {
  const constructorRows = await db
    .selectDistinct({
      id: constructors.id,
      name: constructors.name,
      seasonName: constructorSeasons.displayName,
      color: constructorSeasons.color,
    })
    .from(poolAssets)
    .innerJoin(games, eq(games.id, poolAssets.gameId))
    .innerJoin(constructors, eq(constructors.id, poolAssets.constructorId))
    .leftJoin(
      constructorSeasons,
      and(
        eq(constructorSeasons.constructorId, constructors.id),
        eq(constructorSeasons.seasonId, games.seasonId),
      ),
    )
    .where(and(eq(games.status, "running"), eq(poolAssets.status, "active")));
  const driverRows = await db
    .selectDistinct({
      id: drivers.id,
      givenName: drivers.givenName,
      familyName: drivers.familyName,
      displayName: drivers.displayName,
    })
    .from(poolAssets)
    .innerJoin(games, eq(games.id, poolAssets.gameId))
    .innerJoin(drivers, eq(drivers.id, poolAssets.driverId))
    .where(and(eq(games.status, "running"), eq(poolAssets.status, "active")))
    .orderBy(asc(drivers.familyName));

  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name);
  const seen = new Set<string>();
  return {
    constructors: constructorRows
      .filter((row) => !seen.has(row.id) && seen.add(row.id))
      .map((row) => ({
        id: row.id,
        name: row.seasonName ?? row.name,
        color: row.color ?? "#8a8aa6",
      }))
      .sort(byName),
    drivers: driverRows
      .map((row) => ({
        id: row.id,
        name: row.displayName ?? `${row.givenName} ${row.familyName}`,
      }))
      .sort(byName),
  };
}

/** Codes that CLDR names but that aren't countries a person lives in. */
const NOT_COUNTRIES = new Set([
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

/** ISO 3166-1 alpha-2 codes with their English names, A to Z by name. */
export function countryChoices(): { code: string; name: string }[] {
  const regions = new Intl.DisplayNames(["en"], {
    type: "region",
    fallback: "none",
  });
  const out: { code: string; name: string }[] = [];
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      if (NOT_COUNTRIES.has(code) || normalizeCountryCode(code) === null) {
        continue;
      }
      const name = regions.of(code);
      if (name && name !== code) out.push({ code, name });
    }
  }
  return out.sort((x, y) => x.name.localeCompare(y.name));
}

export type OnboardingState = {
  /** The profile version the next save must pass. */
  version: number;
  favoriteConstructorId: string | null;
  favoriteDriverId: string | null;
  countryCode: string | null;
  spoilerProtection: boolean;
  choices: FavoriteChoices;
  countries: { code: string; name: string }[];
};

export async function onboardingState(
  db: Db,
  viewer: Viewer | null,
): Promise<OnboardingState> {
  const v = requireWritable(viewer);
  return {
    version: v.profile.version,
    favoriteConstructorId: v.profile.favoriteConstructorId,
    favoriteDriverId: v.profile.favoriteDriverId,
    countryCode: v.profile.countryCode,
    spoilerProtection: v.profile.spoilerProtection,
    choices: await favoriteChoices(db),
    countries: countryChoices(),
  };
}

const optionalId = z.uuid().nullable();

export const saveFavoritesInput = z.object({
  expectedVersion: z.number().int().positive(),
  favoriteConstructorId: optionalId,
  favoriteDriverId: optionalId,
  countryCode: z
    .string()
    .regex(/^[A-Za-z]{2}$/)
    .nullable(),
});
export type SaveFavoritesInput = z.infer<typeof saveFavoritesInput>;

export async function saveFavoritesAction(
  db: Db,
  now: Date,
  viewer: Viewer | null,
  input: SaveFavoritesInput,
): Promise<ActionResult<{ version: number }>> {
  const v = requireWritable(viewer);
  // A favorite is a pick from the running game's pool, as the form offers.
  const choices = await favoriteChoices(db);
  if (
    (input.favoriteConstructorId !== null &&
      !choices.constructors.some(
        (c) => c.id === input.favoriteConstructorId,
      )) ||
    (input.favoriteDriverId !== null &&
      !choices.drivers.some((d) => d.id === input.favoriteDriverId))
  ) {
    return { ok: false, error: "invalid_choice" };
  }
  try {
    await updateProfile(db, now, {
      userId: v.userId,
      expectedVersion: input.expectedVersion,
      favoriteConstructorId: input.favoriteConstructorId,
      favoriteDriverId: input.favoriteDriverId,
      countryCode: input.countryCode,
    });
    return { ok: true, version: input.expectedVersion + 1 };
  } catch (error) {
    return refusal(error);
  }
}

export const saveSpoilersInput = z.object({
  expectedVersion: z.number().int().positive(),
  spoilerProtection: z.boolean(),
});
export type SaveSpoilersInput = z.infer<typeof saveSpoilersInput>;

export async function saveSpoilersAction(
  db: Db,
  now: Date,
  viewer: Viewer | null,
  input: SaveSpoilersInput,
): Promise<ActionResult<{ version: number }>> {
  const v = requireWritable(viewer);
  try {
    await updateProfile(db, now, {
      userId: v.userId,
      expectedVersion: input.expectedVersion,
      spoilerProtection: input.spoilerProtection,
    });
    return { ok: true, version: input.expectedVersion + 1 };
  } catch (error) {
    return refusal(error);
  }
}

// --- Checks a form asks without a reload ------------------------------------

export const checkUsernameInput = z.object({
  username: z.string().max(64),
});

export function checkUsernameAction(
  db: Db,
  now: Date,
  username: string,
  userId?: string,
): Promise<UsernameProblem | null> {
  return checkUsername(db, now, username, userId ? { userId } : {});
}

/** True when an ordinary email would wait: "It might take a while today". */
export async function emailBusyAction(db: Db, now: Date): Promise<boolean> {
  return (await emailAllowance(db, now)).busy;
}
