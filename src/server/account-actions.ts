/**
 * What the sign-up and onboarding server functions do (`account.ts` wraps
 * each in a Zod-checked `createServerFn`). Kept apart so the logic can be
 * tested on a database without the Start runtime.
 */
import { and, asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  constructors,
  constructorSeasons,
  drivers,
  seasons,
  seatAssignments,
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
  // `requireViewer`, not `requireWritable`: an unfinished account can't pass
  // that. An admin looking through someone's session still can't finish it
  // for them (Ruling 49).
  const v = requireViewer(viewer);
  if (v.impersonatedBy !== null) throw new IdentityError("read_only");
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

/**
 * What a fan can favor: the latest season's grid, by name. Favorites are
 * global flair (DM 6.2), not a pick from any one game's pool, so this needs no
 * game at all. The season is the newest (by year) that has any
 * `constructor_seasons`; its drivers are everyone who held a race seat at any
 * point in it, so a mid-season replacement is listed.
 */
export async function favoriteChoices(db: Db): Promise<FavoriteChoices> {
  const [latest] = await db
    .select({ seasonId: constructorSeasons.seasonId })
    .from(constructorSeasons)
    .innerJoin(seasons, eq(seasons.id, constructorSeasons.seasonId))
    .orderBy(desc(seasons.year))
    .limit(1);
  if (!latest) return { constructors: [], drivers: [] };

  const constructorRows = await db
    .selectDistinct({
      id: constructors.id,
      name: constructors.name,
      seasonName: constructorSeasons.displayName,
      color: constructorSeasons.color,
    })
    .from(constructorSeasons)
    .innerJoin(
      constructors,
      eq(constructors.id, constructorSeasons.constructorId),
    )
    .where(eq(constructorSeasons.seasonId, latest.seasonId));
  const driverRows = await db
    .selectDistinct({
      id: drivers.id,
      givenName: drivers.givenName,
      familyName: drivers.familyName,
      displayName: drivers.displayName,
    })
    .from(seatAssignments)
    .innerJoin(drivers, eq(drivers.id, seatAssignments.driverId))
    .where(
      and(
        eq(seatAssignments.seasonId, latest.seasonId),
        eq(seatAssignments.role, "race"),
      ),
    )
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
      // `normalizeCountryCode` refuses the retired codes and the ones that
      // aren't countries, so the list offers only what a save accepts.
      if (normalizeCountryCode(code) === null) continue;
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
  // A new favorite is a pick from the latest season's grid, as the form
  // offers. The one already saved may have left the grid (a retired driver,
  // a new season loaded): it stays as flair (DM 6.11), and the form posts it
  // back, so it passes unchecked and a country change still saves.
  const changedConstructor =
    input.favoriteConstructorId !== null &&
    input.favoriteConstructorId !== v.profile.favoriteConstructorId;
  const changedDriver =
    input.favoriteDriverId !== null &&
    input.favoriteDriverId !== v.profile.favoriteDriverId;
  if (changedConstructor || changedDriver) {
    const choices = await favoriteChoices(db);
    if (
      (changedConstructor &&
        !choices.constructors.some(
          (c) => c.id === input.favoriteConstructorId,
        )) ||
      (changedDriver &&
        !choices.drivers.some((d) => d.id === input.favoriteDriverId))
    ) {
      return { ok: false, error: "invalid_choice" };
    }
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

/**
 * The rate-limit key for a username check: the user when signed in, else the
 * address from the headers Better Auth trusts (Vercel's first, as in
 * `ipAddressHeaders`). With neither, the request gets a key of its own, so
 * it can never use up anyone else's allowance.
 */
export function usernameCheckKey(
  headers: Headers,
  userId: string | undefined,
  random: () => string = () => crypto.randomUUID(),
): string {
  if (userId) return `username-check:user:${userId}`;
  const forwarded =
    headers.get("x-vercel-forwarded-for") ?? headers.get("x-forwarded-for");
  const address = forwarded?.split(",")[0]?.trim();
  return address
    ? `username-check:ip:${address}`
    : `username-check:request:${random()}`;
}

/** True when an ordinary email would wait: "It might take a while today". */
export async function emailBusyAction(db: Db, now: Date): Promise<boolean> {
  return (await emailAllowance(db, now)).busy;
}
