/**
 * Usernames (DM 6.3): the format, the reserved names, the 90-day hold on an
 * abandoned name, and the one way to rename. Better Auth's username plugin
 * only stores the name; `changeUsername` is the only rename path.
 *
 * Nothing here reads the clock: `now` comes from the caller.
 */
import { and, eq, gt, ne, sql } from "drizzle-orm";
import {
  constructors,
  drivers,
  filterRules,
  profiles,
  usernameHistory,
  users,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { newId } from "@/lib/ids";
import { getSetting } from "@/settings";
import { IdentityError } from "./viewer";

export type UsernameProblem = "format" | "reserved" | "held" | "taken";

/** How long an abandoned name stays reserved (DM 6.3). */
export const USERNAME_HOLD_DAYS = 90;
export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 20;

const DAY_MS = 24 * 60 * 60 * 1000;
const UNIQUE_VIOLATION = "23505";

/** ASCII letters, digits, underscore and dot: no spaces, accents or look-alike scripts. */
const FORMAT = /^[A-Za-z0-9_.]+$/;

export function isValidUsernameFormat(name: string): boolean {
  return (
    name.length >= USERNAME_MIN_LENGTH &&
    name.length <= USERNAME_MAX_LENGTH &&
    FORMAT.test(name)
  );
}

/** Lower case, accents dropped, separators removed, `0` read as `o`. */
function stripForCheck(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[_.\s-]/g, "")
    .replaceAll("0", "o");
}

/**
 * A name as the reserved-name check compares it: lower case, accents
 * dropped, separators (`_`, `.`, spaces, hyphens) removed, `0` read as `o`
 * and `1` as `l`. For matching only: it is never stored or shown.
 */
export function normalizeForCheck(name: string): string {
  return stripForCheck(name).replaceAll("1", "l");
}

/**
 * One skeleton for word rules and entity names: separators and accents gone,
 * `0`/`o` alike and `1`/`i`/`l` alike, so any mix of look-alikes meets.
 */
function skeleton(name: string): string {
  return stripForCheck(name).replace(/[il1]/g, "l");
}

/** Every reading of a name: `1` as `l` and as `i`. A match on any is a match. */
function normalForms(name: string): string[] {
  const stripped = stripForCheck(name);
  return [stripped.replaceAll("1", "l"), stripped.replaceAll("1", "i")];
}

/**
 * A rule's pattern against the forms of a name it should see: as typed (so
 * `F1_Official` shows `f1` between separators), with zeros read as `o`, and
 * fully normalized.
 */
function ruleMatches(
  rule: { pattern: string; matchType: string },
  forms: string[],
  normalized: string[],
  skel: string,
): boolean {
  if (rule.matchType === "word") {
    // The rule's word is read the same way as the name.
    return skeleton(rule.pattern) === skel;
  }
  if (rule.matchType === "regex") {
    try {
      const re = new RegExp(rule.pattern, "i");
      return [...forms, ...normalized].some((form) => re.test(form));
    } catch {
      // A bad pattern blocks nothing; it must not break sign-up either.
      return false;
    }
  }
  return false;
}

async function isReserved(db: Db, name: string): Promise<boolean> {
  const lower = name.toLowerCase();
  const normalized = normalForms(name);
  const skel = skeleton(name);
  const forms = [lower, lower.replaceAll("0", "o")];

  const rules = await db
    .select({ pattern: filterRules.pattern, matchType: filterRules.matchType })
    .from(filterRules)
    .where(
      and(
        eq(filterRules.scope, "usernames"),
        eq(filterRules.active, true),
        eq(filterRules.effect, "block"),
      ),
    );
  if (rules.some((rule) => ruleMatches(rule, forms, normalized, skel)))
    return true;

  // Read live, so a new driver or team is covered without a seed.
  const driverRows = await db
    .select({
      slug: drivers.slug,
      givenName: drivers.givenName,
      familyName: drivers.familyName,
      displayName: drivers.displayName,
    })
    .from(drivers);
  const constructorRows = await db
    .select({ slug: constructors.slug, name: constructors.name })
    .from(constructors);
  const reserved = new Set<string>();
  for (const d of driverRows) {
    for (const spelling of [
      d.slug,
      d.familyName,
      d.displayName,
      `${d.givenName}${d.familyName}`,
    ]) {
      if (spelling) reserved.add(skeleton(spelling));
    }
  }
  for (const c of constructorRows) {
    reserved.add(skeleton(c.slug));
    reserved.add(skeleton(c.name));
  }
  return skel.length >= USERNAME_MIN_LENGTH && reserved.has(skel);
}

/**
 * Why `name` can't be used, or null when it can. `userId` is the person asking:
 * their own current name is not "taken", nor their own old one "held".
 */
export async function checkUsername(
  db: Db,
  now: Date,
  name: string,
  { userId }: { userId?: string } = {},
): Promise<UsernameProblem | null> {
  if (!isValidUsernameFormat(name)) return "format";
  if (await isReserved(db, name)) return "reserved";

  const lower = name.toLowerCase();
  const [holder] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        sql`lower(${users.username}) = ${lower}`,
        userId ? ne(users.id, userId) : undefined,
      ),
    )
    .limit(1);
  if (holder) return "taken";

  const cutoff = new Date(now.getTime() - USERNAME_HOLD_DAYS * DAY_MS);
  const [held] = await db
    .select({ id: usernameHistory.id })
    .from(usernameHistory)
    .where(
      and(
        sql`lower(${usernameHistory.username}) = ${lower}`,
        gt(usernameHistory.changedAt, cutoff),
        userId ? ne(usernameHistory.userId, userId) : undefined,
      ),
    )
    .limit(1);
  return held ? "held" : null;
}

/** Drivers wrap the Postgres error as a `cause`, so look down the chain. */
function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error, i = 0; e && i < 5; i++, e = (e as Error).cause) {
    if ((e as { code?: unknown }).code === UNIQUE_VIOLATION) return true;
  }
  return false;
}

/**
 * Renames a user. One transaction, with the user's row locked so two renames
 * of one person queue. Refused inside `username_change_days` of the last
 * change. The old name goes to `username_history` and stays held. Two people
 * after one name both pass the check; the unique index lets one in and the
 * other gets `taken`.
 *
 * The same name in other capitals only changes `display_username`: no history,
 * no wait. A first name (the user had none) starts no wait either.
 */
export async function changeUsername(
  db: Db,
  now: Date,
  input: { userId: string; username: string },
  // Only here so a test can stub the check; callers never pass it.
  deps: {
    check?: typeof checkUsername;
  } = {},
): Promise<void> {
  const { userId, username } = input;
  const check = deps.check ?? checkUsername;
  const lower = username.toLowerCase();
  try {
    await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      // FOR NO KEY UPDATE, as everywhere but a delete (Ruling 58): it still
      // queues two renames; the rename itself takes the stronger lock.
      const [user] = await t
        .select({
          username: users.username,
          displayUsername: users.displayUsername,
        })
        .from(users)
        .where(eq(users.id, userId))
        .for("no key update");
      if (!user) throw new IdentityError("unauthenticated");

      if (user.username?.toLowerCase() === lower) {
        if (!isValidUsernameFormat(username)) throw new IdentityError("format");
        await t
          .update(users)
          .set({ displayUsername: username, updatedAt: now })
          .where(eq(users.id, userId));
        return;
      }

      if (user.username) {
        const days = await getSetting(t, "username_change_days");
        const [profile] = await t
          .select({ changedAt: profiles.usernameChangedAt })
          .from(profiles)
          .where(eq(profiles.userId, userId));
        if (
          profile?.changedAt &&
          profile.changedAt.getTime() + days * DAY_MS > now.getTime()
        ) {
          throw new IdentityError("username_too_soon");
        }
      }

      const problem = await check(t, now, username, { userId });
      if (problem) throw new IdentityError(problem);

      if (user.username) {
        await t.insert(usernameHistory).values({
          id: newId(),
          userId,
          username: user.displayUsername ?? user.username,
          changedAt: now,
        });
      }
      await t
        .update(users)
        .set({ username: lower, displayUsername: username, updatedAt: now })
        .where(eq(users.id, userId));
      if (user.username) {
        await t
          .update(profiles)
          .set({ usernameChangedAt: now, updatedAt: now })
          .where(eq(profiles.userId, userId));
      }
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new IdentityError("taken");
    throw error;
  }
}
