/**
 * What the profile and settings server functions do (M5 task 13; `account.ts`
 * wraps each in a Zod-checked `createServerFn`). Kept apart so the logic can
 * be tested on a database without the Start runtime.
 *
 * Reads take `requireComplete`, so an admin looking through someone's session
 * sees their pages; every write takes `requireWritable` (ruling 51b), and a
 * refusal a page can show comes back as `{ ok: false, error }`.
 */
import { and, asc, desc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { writeAudit } from "@/audit/log";
import {
  authAccounts,
  constructors,
  constructorSeasons,
  drivers,
  leagues,
  privacyRequests,
  profiles,
  seasons,
  teams,
  users,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { confirmDeletion, requestDeletion } from "@/identity/delete";
import type { EmailSender } from "@/identity/email/sender";
import { requestExport } from "@/identity/export";
import { hasStaffRole } from "@/identity/roles";
import { changeUsername, USERNAME_HOLD_DAYS } from "@/identity/usernames";
import {
  IdentityError,
  requireComplete,
  requireWritable,
  type IdentityErrorCode,
  type Viewer,
} from "@/identity/viewer";
import {
  andList,
  dayLabel,
  monthLabel,
  trustWords,
  type TrustWords,
} from "@/lib/settings-words";
import { getSetting } from "@/settings";
import {
  countryChoices,
  favoriteChoices,
  saveFavoritesAction,
  saveFavoritesInput,
  saveSpoilersAction,
  saveSpoilersInput,
  type AccountError,
  type FavoriteChoices,
  type SaveFavoritesInput,
  type SaveSpoilersInput,
} from "./account-actions";

const DAY_MS = 24 * 60 * 60 * 1000;

export type SettingsError =
  | AccountError
  | "read_only"
  | "format"
  | "reserved"
  | "held"
  | "taken"
  | "username_too_soon"
  | "version_conflict"
  | "invalid_country"
  | "invalid_choice"
  | "last_method"
  | "not_linked"
  | "export_pending"
  | "export_too_soon"
  | "inactive"
  | "wrong_username"
  | "sign_in_again"
  | "last_admin"
  | "role_reserved"
  | "invalid_link";

export type SettingsResult<T extends object = object> =
  ({ ok: true } & T) | { ok: false; error: SettingsError };

/**
 * Runs `fn`, turning the identity refusals in `codes` (and `read_only`, which
 * every write can meet) into a result; anything else is a real fault.
 */
async function refusing<T extends object>(
  codes: readonly IdentityErrorCode[],
  fn: () => Promise<SettingsResult<T>>,
): Promise<SettingsResult<T>> {
  try {
    return await fn();
  } catch (error) {
    if (
      error instanceof IdentityError &&
      (error.code === "read_only" || codes.includes(error.code))
    ) {
      return { ok: false, error: error.code as SettingsError };
    }
    throw error;
  }
}

const shownName = (v: {
  username: string | null;
  displayUsername: string | null;
}) => v.displayUsername ?? v.username ?? "";

// --- Profile ----------------------------------------------------------------

export type ProfileState = {
  username: string;
  /** The level's name and what it allows (ruling 51f). */
  trust: TrustWords;
  reputation: number;
  /** "Mar 2026". */
  joined: string;
  favorites: {
    team: { name: string; color: string } | null;
    driver: string | null;
    country: string | null;
  };
};

const regionNames = new Intl.DisplayNames(["en"], {
  type: "region",
  fallback: "none",
});

async function favoriteNames(
  db: Db,
  profile: Viewer["profile"],
): Promise<ProfileState["favorites"]> {
  let team: ProfileState["favorites"]["team"] = null;
  if (profile.favoriteConstructorId) {
    // The newest season's name and color, if it has one.
    const [row] = await db
      .select({
        name: constructors.name,
        seasonName: constructorSeasons.displayName,
        color: constructorSeasons.color,
      })
      .from(constructors)
      .leftJoin(
        constructorSeasons,
        eq(constructorSeasons.constructorId, constructors.id),
      )
      .leftJoin(seasons, eq(seasons.id, constructorSeasons.seasonId))
      .where(eq(constructors.id, profile.favoriteConstructorId))
      .orderBy(desc(seasons.year))
      .limit(1);
    if (row) {
      team = {
        name: row.seasonName ?? row.name,
        color: row.color ?? "#8a8aa6",
      };
    }
  }
  let driver: string | null = null;
  if (profile.favoriteDriverId) {
    const [row] = await db
      .select({
        givenName: drivers.givenName,
        familyName: drivers.familyName,
        displayName: drivers.displayName,
      })
      .from(drivers)
      .where(eq(drivers.id, profile.favoriteDriverId));
    if (row) driver = row.displayName ?? `${row.givenName} ${row.familyName}`;
  }
  const country = profile.countryCode
    ? (regionNames.of(profile.countryCode) ?? null)
    : null;
  return { team, driver, country };
}

export async function profileState(
  db: Db,
  viewer: Viewer | null,
): Promise<ProfileState> {
  const v = requireComplete(viewer);
  const [user] = await db
    .select({ createdAt: users.createdAt })
    .from(users)
    .where(eq(users.id, v.userId));
  return {
    username: shownName(v),
    trust: trustWords(v.profile.trustLevel),
    reputation: v.profile.reputation,
    joined: monthLabel(
      user?.createdAt ?? v.profile.createdAt,
      v.profile.timezone,
    ),
    favorites: await favoriteNames(db, v.profile),
  };
}

// --- Settings overview ------------------------------------------------------

export type SettingsOverview = {
  version: number;
  spoilerProtection: boolean;
  username: string;
  /** When the next rename is allowed, or null for now. */
  nextUsernameChange: string | null;
  /** "Mercedes · Antonelli · Italy", or null when none is chosen. */
  favorites: string | null;
  /** "Email and Discord". */
  methods: string;
};

const SHORT_METHOD: Record<string, string> = {
  credential: "Email",
  discord: "Discord",
};
const METHOD_LABEL: Record<string, string> = {
  credential: "Email and password",
  discord: "Discord",
};
const methodOrder = (providerId: string) =>
  providerId === "credential" ? 0 : providerId === "discord" ? 1 : 2;

async function linkedMethods(db: Db, userId: string) {
  const rows = await db
    .select({
      providerId: authAccounts.providerId,
      password: authAccounts.password,
    })
    .from(authAccounts)
    .where(eq(authAccounts.userId, userId))
    .orderBy(asc(authAccounts.createdAt));
  return rows.sort(
    (a, b) => methodOrder(a.providerId) - methodOrder(b.providerId),
  );
}

/** The next day a rename is allowed, written for the person, or null. */
async function nextRename(db: Db, now: Date, userId: string) {
  const days = await getSetting(db, "username_change_days");
  const [profile] = await db
    .select({
      changedAt: profiles.usernameChangedAt,
      timezone: profiles.timezone,
    })
    .from(profiles)
    .where(eq(profiles.userId, userId));
  if (!profile?.changedAt) return { days, label: null };
  const next = new Date(profile.changedAt.getTime() + days * DAY_MS);
  return {
    days,
    label:
      next.getTime() > now.getTime()
        ? dayLabel(next, profile.timezone, now)
        : null,
  };
}

export async function settingsOverview(
  db: Db,
  now: Date,
  viewer: Viewer | null,
): Promise<SettingsOverview> {
  const v = requireComplete(viewer);
  const [user] = await db
    .select({
      username: users.username,
      displayUsername: users.displayUsername,
    })
    .from(users)
    .where(eq(users.id, v.userId));
  const favorites = await favoriteNames(db, v.profile);
  const picked = [
    favorites.team?.name,
    favorites.driver,
    favorites.country,
  ].filter((x): x is string => Boolean(x));
  const methods = await linkedMethods(db, v.userId);
  return {
    version: v.profile.version,
    spoilerProtection: v.profile.spoilerProtection,
    username: shownName(user ?? v),
    nextUsernameChange: (await nextRename(db, now, v.userId)).label,
    favorites: picked.length > 0 ? picked.join(" · ") : null,
    methods: andList(
      methods.map((m) => SHORT_METHOD[m.providerId] ?? m.providerId),
    ),
  };
}

export { saveSpoilersInput as saveSpoilerSettingInput };

/** The Spoilers switch: Task 12's save, with `read_only` as an answer. */
export function saveSpoilerSettingAction(
  db: Db,
  now: Date,
  viewer: Viewer | null,
  input: SaveSpoilersInput,
): Promise<SettingsResult<{ version: number }>> {
  return refusing([], () => saveSpoilersAction(db, now, viewer, input));
}

// --- Favorites --------------------------------------------------------------

export type FavoritesState = {
  version: number;
  favoriteConstructorId: string | null;
  favoriteDriverId: string | null;
  countryCode: string | null;
  choices: FavoriteChoices;
  countries: { code: string; name: string }[];
};

export async function favoritesState(
  db: Db,
  viewer: Viewer | null,
): Promise<FavoritesState> {
  const v = requireComplete(viewer);
  return {
    version: v.profile.version,
    favoriteConstructorId: v.profile.favoriteConstructorId,
    favoriteDriverId: v.profile.favoriteDriverId,
    countryCode: v.profile.countryCode,
    choices: await favoriteChoices(db),
    countries: countryChoices(),
  };
}

export { saveFavoritesInput as saveFavoriteSettingInput };

export function saveFavoriteSettingAction(
  db: Db,
  now: Date,
  viewer: Viewer | null,
  input: SaveFavoritesInput,
): Promise<SettingsResult<{ version: number }>> {
  return refusing([], () => saveFavoritesAction(db, now, viewer, input));
}

// --- Username ---------------------------------------------------------------

export type UsernameState = {
  username: string;
  nextChange: string | null;
  changeDays: number;
  holdDays: number;
};

export async function usernameState(
  db: Db,
  now: Date,
  viewer: Viewer | null,
): Promise<UsernameState> {
  const v = requireComplete(viewer);
  const [user] = await db
    .select({
      username: users.username,
      displayUsername: users.displayUsername,
    })
    .from(users)
    .where(eq(users.id, v.userId));
  const { days, label } = await nextRename(db, now, v.userId);
  return {
    username: shownName(user ?? v),
    nextChange: label,
    changeDays: days,
    holdDays: USERNAME_HOLD_DAYS,
  };
}

export const changeUsernameInput = z.object({
  username: z.string().trim().min(1).max(64),
});

export type ChangeUsernameResult =
  | { ok: true; username: string; nextChange: string | null }
  | { ok: false; error: "username_too_soon"; nextChange: string | null }
  | { ok: false; error: SettingsError };

export async function changeUsernameAction(
  db: Db,
  now: Date,
  viewer: Viewer | null,
  input: z.infer<typeof changeUsernameInput>,
): Promise<ChangeUsernameResult> {
  const result = await refusing(
    ["format", "reserved", "held", "taken", "username_too_soon"],
    async () => {
      const v = requireWritable(viewer);
      await changeUsername(db, now, {
        userId: v.userId,
        username: input.username,
      });
      return { ok: true as const };
    },
  );
  const userId = viewer?.userId;
  if (result.ok) {
    return {
      ok: true,
      username: input.username,
      nextChange: userId ? (await nextRename(db, now, userId)).label : null,
    };
  }
  if (result.error === "username_too_soon" && userId) {
    return {
      ok: false,
      error: "username_too_soon",
      nextChange: (await nextRename(db, now, userId)).label,
    };
  }
  return result;
}

// --- Sign-in methods --------------------------------------------------------

export type SignInMethodsState = {
  email: string;
  methods: { providerId: string; label: string }[];
};

export async function signInMethodsState(
  db: Db,
  viewer: Viewer | null,
): Promise<SignInMethodsState> {
  const v = requireComplete(viewer);
  const [user] = await db
    .select({ email: users.email })
    .from(users)
    .where(eq(users.id, v.userId));
  const methods = await linkedMethods(db, v.userId);
  return {
    email: user?.email ?? "",
    methods: methods.map((m) => ({
      providerId: m.providerId,
      label: METHOD_LABEL[m.providerId] ?? m.providerId,
    })),
  };
}

export const removeSignInMethodInput = z.object({
  providerId: z.string().min(1).max(64),
});

/**
 * Unlinks one sign-in method. The last one is refused (`last_method`), here
 * and not only by a disabled button (ruling 51d): the user's row is locked
 * so two removals at once can't leave none. Better Auth's own
 * `/unlink-account` is closed over HTTP, so this is the only way, and it is
 * audited.
 */
export async function removeSignInMethodAction(
  db: Db,
  now: Date,
  viewer: Viewer | null,
  input: z.infer<typeof removeSignInMethodInput>,
): Promise<SettingsResult> {
  return refusing([], async () => {
    const v = requireWritable(viewer);
    return db.transaction(async (tx): Promise<SettingsResult> => {
      const t = tx as unknown as Db;
      await t
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, v.userId))
        .for("update");
      const methods = await t
        .select({ id: authAccounts.id, providerId: authAccounts.providerId })
        .from(authAccounts)
        .where(eq(authAccounts.userId, v.userId));
      const target = methods.filter((m) => m.providerId === input.providerId);
      if (target.length === 0) return { ok: false, error: "not_linked" };
      if (methods.length - target.length < 1) {
        return { ok: false, error: "last_method" };
      }
      await t
        .delete(authAccounts)
        .where(
          and(
            eq(authAccounts.userId, v.userId),
            eq(authAccounts.providerId, input.providerId),
          ),
        );
      await writeAudit(t, now, {
        actorUserId: v.userId,
        actorKind: "user",
        actorLabel: null,
        action: "user.sign_in_method.remove",
        entityType: "user",
        entityId: v.userId,
        before: { providerId: input.providerId },
        after: { methodsLeft: methods.length - target.length },
        reason: null,
        requestId: null,
      });
      return { ok: true };
    });
  });
}

// --- Security ---------------------------------------------------------------

export type SecurityState = {
  hasPassword: boolean;
  /** Staff get the two-step set-up (DM 6.4). */
  staff: boolean;
  twoFactorEnabled: boolean;
  /** This session has passed the staff two-step. */
  staffUnlocked: boolean;
};

export async function securityState(
  db: Db,
  viewer: Viewer | null,
): Promise<SecurityState> {
  const v = requireComplete(viewer);
  const methods = await linkedMethods(db, v.userId);
  return {
    hasPassword: methods.some(
      (m) => m.providerId === "credential" && m.password !== null,
    ),
    staff: !v.banned && hasStaffRole(v.role, "moderator"),
    twoFactorEnabled: v.twoFactorEnabled,
    staffUnlocked: v.staffVerifiedAt !== null,
  };
}

// --- Data export ------------------------------------------------------------

export type ExportState =
  | { status: "none" | "pending" | "expired" | "failed" }
  | { status: "ready"; url: string; worksUntil: string };

/** The latest export asked for, as the page shows it. */
export async function exportState(
  db: Db,
  now: Date,
  viewer: Viewer | null,
): Promise<ExportState> {
  const v = requireComplete(viewer);
  const [row] = await db
    .select({
      status: privacyRequests.status,
      url: privacyRequests.exportUrl,
      expiresAt: privacyRequests.exportExpiresAt,
    })
    .from(privacyRequests)
    .where(
      and(
        eq(privacyRequests.userId, v.userId),
        eq(privacyRequests.kind, "export"),
      ),
    )
    .orderBy(desc(privacyRequests.requestedAt), desc(privacyRequests.id))
    .limit(1);
  if (!row) return { status: "none" };
  if (row.status === "pending" || row.status === "processing") {
    return { status: "pending" };
  }
  if (row.status === "completed") {
    if (row.url && row.expiresAt && row.expiresAt.getTime() > now.getTime()) {
      return {
        status: "ready",
        url: row.url,
        worksUntil: dayLabel(row.expiresAt, v.profile.timezone, now),
      };
    }
    return { status: "expired" };
  }
  return { status: "failed" };
}

export function requestExportAction(
  db: Db,
  now: Date,
  viewer: Viewer | null,
): Promise<SettingsResult> {
  return refusing(
    ["export_pending", "export_too_soon", "inactive"],
    async () => {
      const v = requireWritable(viewer);
      await requestExport(db, now, { userId: v.userId });
      return { ok: true };
    },
  );
}

// --- Deletion ---------------------------------------------------------------

export type DeletePageState = {
  username: string;
  emailVerified: boolean;
  /** Teams that stop playing. */
  teams: string[];
  /** Leagues they run, which carry on. */
  leagues: string[];
};

export async function deletePageState(
  db: Db,
  viewer: Viewer | null,
): Promise<DeletePageState> {
  const v = requireComplete(viewer);
  const [user] = await db
    .select({
      username: users.username,
      displayUsername: users.displayUsername,
      emailVerified: users.emailVerified,
    })
    .from(users)
    .where(eq(users.id, v.userId));
  const ownTeams = await db
    .select({ name: teams.name })
    .from(teams)
    .where(and(eq(teams.userId, v.userId), ne(teams.status, "retired")))
    .orderBy(asc(teams.createdAt), asc(teams.slot));
  const owned = await db
    .select({ name: leagues.name })
    .from(leagues)
    .where(eq(leagues.ownerUserId, v.userId))
    .orderBy(asc(leagues.createdAt));
  return {
    username: shownName(user ?? v),
    emailVerified: user?.emailVerified ?? v.emailVerified,
    teams: ownTeams.map((t) => t.name),
    leagues: owned.map((l) => l.name),
  };
}

export const requestDeletionInput = z.object({
  typedUsername: z.string().max(320),
});

export function requestDeletionAction(
  db: Db,
  now: Date,
  viewer: Viewer | null,
  input: z.infer<typeof requestDeletionInput>,
  deps: { sender: EmailSender | null; baseUrl: string },
): Promise<SettingsResult<{ confirm: "email" | "fresh_sign_in" }>> {
  return refusing(
    [
      "wrong_username",
      "sign_in_again",
      "last_admin",
      "role_reserved",
      "inactive",
    ],
    async () => {
      const v = requireWritable(viewer);
      const { confirm } = await requestDeletion(
        db,
        now,
        { viewer: v, typedUsername: input.typedUsername },
        deps,
      );
      return { ok: true, confirm };
    },
  );
}

export const confirmDeletionInput = z.object({
  token: z.string().min(1).max(512),
});

/**
 * The emailed link's button. The token is the proof, so no sign-in is
 * needed; an admin looking through someone's session is still refused.
 */
export function confirmDeletionAction(
  db: Db,
  now: Date,
  viewer: Viewer | null,
  input: z.infer<typeof confirmDeletionInput>,
): Promise<SettingsResult> {
  return refusing(["invalid_link", "last_admin", "role_reserved"], async () => {
    if (viewer?.impersonatedBy) throw new IdentityError("read_only");
    await confirmDeletion(db, now, { token: input.token });
    return { ok: true };
  });
}
