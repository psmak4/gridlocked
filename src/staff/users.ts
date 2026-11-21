/**
 * User lookup for staff (M8 Task 12, wave 5's users board): a search by
 * username prefix, never by email, and one user's detail with their role,
 * trust, restrictions, recent actions and trust history, and the actions the
 * viewer may take, grouped as Account (admins only), Trust and Restrictions.
 * The actions themselves are `setRole`, `banUser`, `setTrustLevel`,
 * `moderate` and the rest; this file only reads.
 */
import {
  and,
  asc,
  desc,
  eq,
  gt,
  ilike,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import {
  profiles,
  trustLevelChanges,
  userRestrictions,
  usernameHistory,
  users,
  type RestrictionKind,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { accountActions, type AccountAction } from "@/community/moderate";

/** A search answers this many at most. */
const FIND_LIMIT = 20;

export type FoundUser = {
  userId: string;
  username: string;
  role: string;
  trustLevel: number;
  banned: boolean;
  /** "Mar 2026". */
  joined: string;
};

export type UserActionGroup = "account" | "trust" | "restrictions";

export type UserActionId =
  | "set_role"
  | "ban"
  | "unban"
  | "impersonate"
  | "set_trust"
  | "clear_trust_lock"
  | "warn"
  | "mute"
  | "unmute"
  | "chat_ban"
  | "chat_unban";

export type UserAction = {
  id: UserActionId;
  group: UserActionGroup;
  label: string;
};

export type UserDetail = {
  userId: string;
  /** Null for a deleted account's tombstone. */
  username: string | null;
  deleted: boolean;
  role: string;
  /** Banned now, and until when (null: until lifted). */
  ban: { until: Date | null; reason: string | null } | null;
  trust: { level: number; locked: boolean };
  /** Mutes and chat bans in force. */
  restrictions: { kind: RestrictionKind; until: Date | null; reason: string }[];
  recent: AccountAction[];
  trustHistory: {
    from: number;
    to: number;
    source: string;
    reason: string | null;
    at: Date;
  }[];
  joined: string;
  actions: UserAction[];
};

const MONTH_YEAR = new Intl.DateTimeFormat("en-GB", {
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** `%`, `_` and `\` are letters in a search, not patterns. */
function likePrefix(text: string): string {
  return `${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Accounts whose username starts with `query` (any case), at most 20, by
 * username. Anything with an `@` finds nothing: staff never look people up
 * by address. Tombstones have no username, so they never match.
 */
export async function findUsers(db: Db, query: string): Promise<FoundUser[]> {
  const text = query.trim();
  if (text.length === 0 || text.includes("@")) return [];
  const rows = await db
    .select({
      userId: users.id,
      username: users.username,
      displayUsername: users.displayUsername,
      role: users.role,
      banned: users.banned,
      createdAt: users.createdAt,
      trustLevel: profiles.trustLevel,
    })
    .from(users)
    .innerJoin(profiles, eq(profiles.userId, users.id))
    .where(
      and(
        ilike(users.username, likePrefix(text.toLowerCase())),
        ne(users.role, "system"),
        ne(profiles.status, "deleted"),
      ),
    )
    .orderBy(asc(users.username))
    .limit(FIND_LIMIT);
  return rows.map((r) => ({
    userId: r.userId,
    username: r.displayUsername ?? r.username ?? "",
    role: r.role,
    trustLevel: r.trustLevel,
    banned: r.banned,
    joined: MONTH_YEAR.format(r.createdAt),
  }));
}

/** The user with this username now, or the tombstone still holding it. */
async function resolveUsername(db: Db, username: string) {
  const name = username.trim().toLowerCase();
  if (!name) return null;
  const [live] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, name));
  if (live) return live.id;
  // A deleted account's name stays held for 90 days (DM 6.3): it still finds
  // the tombstone, which shows without it.
  const [held] = await db
    .select({ userId: usernameHistory.userId })
    .from(usernameHistory)
    .innerJoin(profiles, eq(profiles.userId, usernameHistory.userId))
    .where(
      and(
        sql`lower(${usernameHistory.username}) = ${name}`,
        eq(profiles.status, "deleted"),
      ),
    )
    .orderBy(desc(usernameHistory.changedAt))
    .limit(1);
  return held?.userId ?? null;
}

function actionsFor(
  viewerRole: "moderator" | "admin",
  target: {
    role: string;
    banned: boolean;
    locked: boolean;
    muted: boolean;
    chatBanned: boolean;
  },
): UserAction[] {
  const staff = target.role === "admin" || target.role === "moderator";
  const actions: UserAction[] = [];
  if (viewerRole === "admin") {
    actions.push({ id: "set_role", group: "account", label: "Change role" });
    actions.push(
      target.banned
        ? { id: "unban", group: "account", label: "Lift the ban" }
        : { id: "ban", group: "account", label: "Ban" },
    );
    // Nobody views the site as an admin, or as someone banned.
    if (target.role !== "admin" && !target.banned) {
      actions.push({
        id: "impersonate",
        group: "account",
        label: "View the site as them",
      });
    }
  }
  // A moderator doesn't act on staff; an admin does, through Account.
  if (viewerRole === "moderator" && staff) return actions;
  actions.push({
    id: "set_trust",
    group: "trust",
    label: "Set trust level",
  });
  if (target.locked) {
    actions.push({
      id: "clear_trust_lock",
      group: "trust",
      label: "Hand back to the nightly job",
    });
  }
  actions.push({ id: "warn", group: "restrictions", label: "Warn" });
  actions.push(
    target.muted
      ? { id: "unmute", group: "restrictions", label: "Lift the mute" }
      : { id: "mute", group: "restrictions", label: "Mute" },
  );
  actions.push(
    target.chatBanned
      ? { id: "chat_unban", group: "restrictions", label: "Lift the chat ban" }
      : { id: "chat_ban", group: "restrictions", label: "Ban from chat" },
  );
  return actions;
}

/**
 * One user, by username (any case), with what `viewerRole` may do to them;
 * null if nobody has that name. A deleted account shows as its tombstone,
 * with no username and no actions.
 */
export async function userDetail(
  db: Db,
  now: Date,
  input: { username: string; viewerRole: "moderator" | "admin" },
): Promise<UserDetail | null> {
  const userId = await resolveUsername(db, input.username);
  if (!userId) return null;
  const [row] = await db
    .select({
      username: users.username,
      displayUsername: users.displayUsername,
      role: users.role,
      banned: users.banned,
      banReason: users.banReason,
      banExpires: users.banExpires,
      createdAt: users.createdAt,
      trustLevel: profiles.trustLevel,
      locked: profiles.trustLevelLocked,
      status: profiles.status,
    })
    .from(users)
    .innerJoin(profiles, eq(profiles.userId, users.id))
    .where(eq(users.id, userId));
  if (!row || row.role === "system") return null;
  const deleted = row.status === "deleted";

  const restrictions = await db
    .select({
      kind: userRestrictions.kind,
      until: userRestrictions.until,
      reason: userRestrictions.reason,
    })
    .from(userRestrictions)
    .where(
      and(
        eq(userRestrictions.userId, userId),
        isNull(userRestrictions.liftedAt),
        or(isNull(userRestrictions.until), gt(userRestrictions.until, now)),
      ),
    )
    .orderBy(desc(userRestrictions.createdAt));
  const history = await db
    .select({
      from: trustLevelChanges.fromLevel,
      to: trustLevelChanges.toLevel,
      source: trustLevelChanges.source,
      reason: trustLevelChanges.reason,
      at: trustLevelChanges.changedAt,
    })
    .from(trustLevelChanges)
    .where(eq(trustLevelChanges.userId, userId))
    .orderBy(desc(trustLevelChanges.changedAt))
    .limit(10);

  const banned =
    row.banned &&
    (row.banExpires === null || row.banExpires.getTime() > now.getTime());
  return {
    userId,
    username: deleted ? null : (row.displayUsername ?? row.username),
    deleted,
    role: row.role,
    ban: banned ? { until: row.banExpires, reason: row.banReason } : null,
    trust: { level: row.trustLevel, locked: row.locked },
    restrictions,
    recent: await accountActions(db, userId, 10),
    trustHistory: history,
    joined: MONTH_YEAR.format(row.createdAt),
    actions: deleted
      ? []
      : actionsFor(input.viewerRole, {
          role: row.role,
          banned,
          locked: row.locked,
          muted: restrictions.some((r) => r.kind === "mute"),
          chatBanned: restrictions.some((r) => r.kind === "chat_ban"),
        }),
  };
}
