/**
 * Where a user's data lives (DM 6.7): one entry per user column. Both the
 * export (`buildExport`) and the deletion (`scrubAccount`) walk this list, so
 * a table that isn't here is missed by both. `personal-data.test.ts` walks the
 * schema and fails for any foreign key to `users` that has no entry, which is
 * what makes M7 register its posts, votes, chat, notifications and watch
 * marks.
 *
 * - `onDelete` is what the scrub does: `delete` the rows, `scrub` them (clear
 *   the personal fields, keep the row on the tombstone), `retire` them (the
 *   game's word: the row stays for history) or `keep` them as they are, for
 *   the reason in `why`.
 * - `exportAs` is the export's section, read by `read`; null when the column
 *   holds nothing the user gave us about themself (a staff member's own
 *   work), or only secrets.
 * - The order is the scrub's order. Two entries aren't foreign keys but are
 *   keyed by the address (`auth_verifications`, `email_outbox`); they come
 *   first, while the context still has it.
 *
 * Nothing here returns a token, a hash, a secret or a password: readers pick
 * their columns by name, never `select *`.
 */
import { and, asc, eq, inArray, isNull, like, or, sql } from "drizzle-orm";
import {
  authAccounts,
  authSessions,
  authTwoFactors,
  authVerifications,
  chipPlays,
  constructors,
  drivers,
  emailOutbox,
  events,
  games,
  leagueMemberships,
  leagues,
  legalAcceptances,
  legalDocuments,
  lineupPicks,
  lineupVersions,
  poolAssets,
  privacyRequests,
  profiles,
  teams,
  trustLevelChanges,
  usernameHistory,
  users,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { newId } from "@/lib/ids";

/** What the scrub knows about the account, read before it changes anything. */
export interface ScrubContext {
  now: Date;
  userId: string;
  /** The address before the scrub, as stored. */
  email: string;
  username: string | null;
  displayUsername: string | null;
}

export interface PersonalDataEntry {
  table: string;
  userColumn: string;
  onDelete: "scrub" | "delete" | "keep" | "retire";
  why: string;
  exportAs: string | null;
  read?: (db: Db, userId: string) => Promise<unknown>;
  /** The scrub's step for this entry, inside its transaction. */
  scrub?: (tx: Db, ctx: ScrubContext) => Promise<void>;
}

/** The address a deleted account keeps, so `users.email` stays unique. */
export const tombstoneEmail = (userId: string) =>
  `deleted-${userId}@deleted.invalid`;

export const DELETED_TEAM_NAME = "Deleted team";

const iso = (d: Date | null) => d?.toISOString() ?? null;

const lower = (email: string) => email.trim().toLowerCase();

/** Magic-link rows hold `{"email": …}` as JSON; anything else isn't one of ours. */
function namesEmail(value: string, email: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as { email?: unknown }).email === "string" &&
      lower((parsed as { email: string }).email) === lower(email)
    );
  } catch {
    return false;
  }
}

async function readTeams(db: Db, userId: string) {
  const own = await db
    .select({
      id: teams.id,
      game: games.slug,
      slot: teams.slot,
      name: teams.name,
      status: teams.status,
      createdAt: teams.createdAt,
    })
    .from(teams)
    .innerJoin(games, eq(games.id, teams.gameId))
    .where(eq(teams.userId, userId))
    .orderBy(asc(teams.createdAt), asc(teams.id));
  if (own.length === 0) return [];
  const teamIds = own.map((t) => t.id);

  const versions = await db
    .select({
      id: lineupVersions.id,
      teamId: lineupVersions.teamId,
      event: events.slug,
      kind: lineupVersions.kind,
      savedAt: lineupVersions.savedAt,
    })
    .from(lineupVersions)
    .innerJoin(events, eq(events.id, lineupVersions.forEventId))
    .where(inArray(lineupVersions.teamId, teamIds))
    .orderBy(asc(lineupVersions.savedAt), asc(lineupVersions.id));
  const picks =
    versions.length === 0
      ? []
      : await db
          .select({
            versionId: lineupPicks.lineupVersionId,
            type: poolAssets.assetType,
            driver: drivers.slug,
            constructor: constructors.slug,
            boost: lineupPicks.isBoost,
          })
          .from(lineupPicks)
          .innerJoin(poolAssets, eq(poolAssets.id, lineupPicks.assetId))
          .leftJoin(drivers, eq(drivers.id, poolAssets.driverId))
          .leftJoin(constructors, eq(constructors.id, poolAssets.constructorId))
          .where(
            inArray(
              lineupPicks.lineupVersionId,
              versions.map((v) => v.id),
            ),
          )
          .orderBy(asc(poolAssets.assetType), asc(drivers.slug));
  const chips = await db
    .select({
      teamId: chipPlays.teamId,
      chip: chipPlays.chipCode,
      event: events.slug,
      status: chipPlays.status,
      playedAt: chipPlays.playedAt,
    })
    .from(chipPlays)
    .innerJoin(events, eq(events.id, chipPlays.eventId))
    .where(inArray(chipPlays.teamId, teamIds))
    .orderBy(asc(chipPlays.playedAt));
  const memberships = await db
    .select({
      teamId: leagueMemberships.teamId,
      league: leagues.name,
      kind: leagues.kind,
      source: leagueMemberships.source,
      joinedAt: leagueMemberships.joinedAt,
      leftAt: leagueMemberships.leftAt,
    })
    .from(leagueMemberships)
    .innerJoin(leagues, eq(leagues.id, leagueMemberships.leagueId))
    .where(inArray(leagueMemberships.teamId, teamIds))
    .orderBy(asc(leagueMemberships.joinedAt));

  return own.map((team) => ({
    ...team,
    createdAt: iso(team.createdAt),
    lineups: versions
      .filter((v) => v.teamId === team.id)
      .map((v) => ({
        id: v.id,
        event: v.event,
        kind: v.kind,
        savedAt: iso(v.savedAt),
        picks: picks
          .filter((p) => p.versionId === v.id)
          .map((p) => ({
            type: p.type,
            asset: p.driver ?? p.constructor,
            boost: p.boost,
          })),
      })),
    chipPlays: chips
      .filter((c) => c.teamId === team.id)
      .map((c) => ({
        chip: c.chip,
        event: c.event,
        status: c.status,
        playedAt: iso(c.playedAt),
      })),
    leagueMemberships: memberships
      .filter((m) => m.teamId === team.id)
      .map((m) => ({
        league: m.league,
        kind: m.kind,
        source: m.source,
        joinedAt: iso(m.joinedAt),
        leftAt: iso(m.leftAt),
      })),
  }));
}

const KEEP_STAFF =
  "a staff member's own work (config, decisions, reviews), kept so the record says someone did it; the column holds only the id, which now names the tombstone";

export const PERSONAL_DATA: PersonalDataEntry[] = [
  {
    table: "auth_verifications",
    userColumn: "identifier",
    onDelete: "delete",
    why: "pending sign-in, reset and verification links, keyed by the address or the user id, and magic links whose JSON value names the address",
    exportAs: null,
    async scrub(tx, { userId, email }) {
      await tx
        .delete(authVerifications)
        .where(
          or(
            sql`lower(${authVerifications.identifier}) = ${lower(email)}`,
            eq(authVerifications.value, userId),
          ),
        );
      const links = await tx
        .select({ id: authVerifications.id, value: authVerifications.value })
        .from(authVerifications)
        .where(like(authVerifications.identifier, "magic-link:%"));
      const mine = links.filter((l) => namesEmail(l.value, email));
      if (mine.length > 0) {
        await tx.delete(authVerifications).where(
          inArray(
            authVerifications.id,
            mine.map((l) => l.id),
          ),
        );
      }
    },
  },
  {
    table: "email_outbox",
    userColumn: "to_email",
    onDelete: "scrub",
    why: "queued and retrying mail to the address is deleted; finished rows stay, on the tombstone address, so the month's count stays right",
    exportAs: null,
    async scrub(tx, { userId, email }) {
      const address = sql`lower(${emailOutbox.toEmail}) = ${lower(email)}`;
      await tx
        .delete(emailOutbox)
        .where(and(eq(emailOutbox.status, "queued"), address));
      await tx
        .update(emailOutbox)
        .set({ toEmail: tombstoneEmail(userId), payload: {} })
        .where(address);
    },
  },
  {
    table: "auth_sessions",
    userColumn: "user_id",
    onDelete: "delete",
    why: "sign-in state: every session ends with the account",
    exportAs: "sessions",
    async read(db, userId) {
      const rows = await db
        .select({
          createdAt: authSessions.createdAt,
          expiresAt: authSessions.expiresAt,
          ipAddress: authSessions.ipAddress,
          userAgent: authSessions.userAgent,
        })
        .from(authSessions)
        .where(eq(authSessions.userId, userId))
        .orderBy(asc(authSessions.createdAt));
      return rows.map((r) => ({
        ...r,
        createdAt: iso(r.createdAt),
        expiresAt: iso(r.expiresAt),
      }));
    },
    async scrub(tx, { userId }) {
      await tx.delete(authSessions).where(eq(authSessions.userId, userId));
    },
  },
  {
    table: "auth_sessions",
    userColumn: "impersonated_by",
    onDelete: "delete",
    why: "a session an admin holds as someone else ends with the admin's account",
    exportAs: null,
    async scrub(tx, { userId }) {
      await tx
        .delete(authSessions)
        .where(eq(authSessions.impersonatedBy, userId));
    },
  },
  {
    table: "auth_accounts",
    userColumn: "user_id",
    onDelete: "delete",
    why: "sign-in methods (the password hash, Discord's tokens): a tombstone can't sign in, and Discord makes a new account next time",
    exportAs: "signInMethods",
    async read(db, userId) {
      const rows = await db
        .select({
          provider: authAccounts.providerId,
          linkedAt: authAccounts.createdAt,
        })
        .from(authAccounts)
        .where(eq(authAccounts.userId, userId))
        .orderBy(asc(authAccounts.providerId));
      return rows.map((r) => ({ ...r, linkedAt: iso(r.linkedAt) }));
    },
    async scrub(tx, { userId }) {
      await tx.delete(authAccounts).where(eq(authAccounts.userId, userId));
    },
  },
  {
    table: "auth_two_factors",
    userColumn: "user_id",
    onDelete: "delete",
    why: "the TOTP secret and backup codes; only secrets, so nothing is exported",
    exportAs: null,
    async scrub(tx, { userId }) {
      await tx.delete(authTwoFactors).where(eq(authTwoFactors.userId, userId));
    },
  },
  {
    table: "users",
    userColumn: "id",
    onDelete: "scrub",
    why: "the row is the tombstone every foreign key points at: the address becomes deleted-<id>@deleted.invalid, the names and image are cleared and the role is user",
    exportAs: "account",
    async read(db, userId) {
      const [row] = await db
        .select({
          id: users.id,
          email: users.email,
          emailVerified: users.emailVerified,
          name: users.name,
          username: users.username,
          displayUsername: users.displayUsername,
          image: users.image,
          role: users.role,
          twoFactorEnabled: users.twoFactorEnabled,
          createdAt: users.createdAt,
        })
        .from(users)
        .where(eq(users.id, userId));
      return row ? { ...row, createdAt: iso(row.createdAt) } : null;
    },
    async scrub(tx, { now, userId }) {
      await tx
        .update(users)
        .set({
          email: tombstoneEmail(userId),
          emailVerified: false,
          name: "",
          image: null,
          username: null,
          displayUsername: null,
          role: "user",
          banned: false,
          banReason: null,
          banExpires: null,
          twoFactorEnabled: false,
          updatedAt: now,
        })
        .where(eq(users.id, userId));
    },
  },
  {
    table: "profiles",
    userColumn: "user_id",
    onDelete: "scrub",
    why: "every field back to empty or its default, and status deleted, which the daily jobs and the sign-in checks read",
    exportAs: "profile",
    async read(db, userId) {
      const [row] = await db
        .select({
          status: profiles.status,
          avatarSeed: profiles.avatarSeed,
          favoriteConstructor: constructors.slug,
          favoriteDriver: drivers.slug,
          countryCode: profiles.countryCode,
          timezone: profiles.timezone,
          spoilerProtection: profiles.spoilerProtection,
          ageConfirmedAt: profiles.ageConfirmedAt,
          trustLevel: profiles.trustLevel,
          reputation: profiles.reputation,
          daysVisited: profiles.daysVisited,
          lastSeenAt: profiles.lastSeenAt,
          usernameChangedAt: profiles.usernameChangedAt,
          createdAt: profiles.createdAt,
        })
        .from(profiles)
        .leftJoin(
          constructors,
          eq(constructors.id, profiles.favoriteConstructorId),
        )
        .leftJoin(drivers, eq(drivers.id, profiles.favoriteDriverId))
        .where(eq(profiles.userId, userId));
      if (!row) return null;
      return {
        ...row,
        ageConfirmedAt: iso(row.ageConfirmedAt),
        lastSeenAt: iso(row.lastSeenAt),
        usernameChangedAt: iso(row.usernameChangedAt),
        createdAt: iso(row.createdAt),
      };
    },
    async scrub(tx, { now, userId }) {
      await tx
        .update(profiles)
        .set({
          status: "deleted",
          avatarSeed: userId,
          favoriteConstructorId: null,
          favoriteDriverId: null,
          countryCode: null,
          timezone: "UTC",
          spoilerProtection: true,
          ageConfirmedAt: null,
          trustLevel: 0,
          trustLevelLocked: false,
          reputation: 0,
          daysVisited: 0,
          lastSeenAt: null,
          broadcastsReadAt: null,
          usernameChangedAt: null,
          updatedAt: now,
          version: sql`${profiles.version} + 1`,
        })
        .where(eq(profiles.userId, userId));
    },
  },
  {
    table: "username_history",
    userColumn: "user_id",
    onDelete: "keep",
    why: "old names stay held for 90 days so nobody can take a just-abandoned name to pose as its owner (DM 6.3); the scrub adds the current name, and the daily prune releases a tombstone's names after 90 days",
    exportAs: "usernameHistory",
    async read(db, userId) {
      const rows = await db
        .select({
          username: usernameHistory.username,
          changedAt: usernameHistory.changedAt,
        })
        .from(usernameHistory)
        .where(eq(usernameHistory.userId, userId))
        .orderBy(asc(usernameHistory.changedAt));
      return rows.map((r) => ({ ...r, changedAt: iso(r.changedAt) }));
    },
    async scrub(tx, { now, userId, username, displayUsername }) {
      const name = displayUsername ?? username;
      if (!name) return;
      await tx
        .insert(usernameHistory)
        .values({ id: newId(), userId, username: name, changedAt: now });
    },
  },
  {
    table: "teams",
    userColumn: "user_id",
    onDelete: "retire",
    why: "league history and past standings stay correct: the teams are retired, named Deleted team, and leave every league",
    exportAs: "teams",
    read: readTeams,
    async scrub(tx, { now, userId }) {
      const own = await tx
        .update(teams)
        .set({ status: "retired", name: DELETED_TEAM_NAME, updatedAt: now })
        .where(eq(teams.userId, userId))
        .returning({ id: teams.id });
      if (own.length === 0) return;
      await tx
        .update(leagueMemberships)
        .set({ leftAt: now })
        .where(
          and(
            inArray(
              leagueMemberships.teamId,
              own.map((t) => t.id),
            ),
            isNull(leagueMemberships.leftAt),
          ),
        );
    },
  },
  {
    table: "leagues",
    userColumn: "owner_user_id",
    onDelete: "scrub",
    why: "a league they own stays active for its other members, with no owner until an admin reassigns it (DM 4.5)",
    exportAs: "leaguesOwned",
    async read(db, userId) {
      const rows = await db
        .select({
          name: leagues.name,
          kind: leagues.kind,
          slug: leagues.slug,
          status: leagues.status,
          createdAt: leagues.createdAt,
        })
        .from(leagues)
        .where(eq(leagues.ownerUserId, userId))
        .orderBy(asc(leagues.createdAt));
      return rows.map((r) => ({ ...r, createdAt: iso(r.createdAt) }));
    },
    async scrub(tx, { now, userId }) {
      await tx
        .update(leagues)
        .set({ ownerUserId: null, updatedAt: now })
        .where(eq(leagues.ownerUserId, userId));
    },
  },
  {
    table: "privacy_requests",
    userColumn: "user_id",
    onDelete: "scrub",
    why: "the requests stay as the record that they were made; links, token hashes and open exports are cleared, and the daily expireExports deletes any export file",
    exportAs: "privacyRequests",
    async read(db, userId) {
      const rows = await db
        .select({
          kind: privacyRequests.kind,
          status: privacyRequests.status,
          requestedAt: privacyRequests.requestedAt,
          completedAt: privacyRequests.completedAt,
        })
        .from(privacyRequests)
        .where(eq(privacyRequests.userId, userId))
        .orderBy(asc(privacyRequests.requestedAt));
      return rows.map((r) => ({
        ...r,
        requestedAt: iso(r.requestedAt),
        completedAt: iso(r.completedAt),
      }));
    },
    async scrub(tx, { userId }) {
      // The object key stays until expireExports has deleted the file.
      await tx
        .update(privacyRequests)
        .set({
          exportUrl: null,
          confirmTokenHash: null,
          confirmExpiresAt: null,
        })
        .where(eq(privacyRequests.userId, userId));
      await tx
        .update(privacyRequests)
        .set({ status: "failed" })
        .where(
          and(
            eq(privacyRequests.userId, userId),
            inArray(privacyRequests.status, ["pending", "processing"]),
          ),
        );
    },
  },
  {
    table: "legal_acceptances",
    userColumn: "user_id",
    onDelete: "keep",
    why: "the record that the terms in force were accepted, which we may need to show; it holds only the id, a document and a time",
    exportAs: "legalAcceptances",
    async read(db, userId) {
      const rows = await db
        .select({
          kind: legalDocuments.kind,
          version: legalDocuments.version,
          acceptedAt: legalAcceptances.acceptedAt,
        })
        .from(legalAcceptances)
        .innerJoin(
          legalDocuments,
          eq(legalDocuments.id, legalAcceptances.documentId),
        )
        .where(eq(legalAcceptances.userId, userId))
        .orderBy(asc(legalDocuments.kind), asc(legalAcceptances.acceptedAt));
      return rows.map((r) => ({ ...r, acceptedAt: iso(r.acceptedAt) }));
    },
  },
  {
    table: "trust_level_changes",
    userColumn: "user_id",
    onDelete: "keep",
    why: "moderation history about the user, kept for the 2-year retention period (DM 5.10); levels and times only",
    exportAs: "trustLevelChanges",
    async read(db, userId) {
      const rows = await db
        .select({
          fromLevel: trustLevelChanges.fromLevel,
          toLevel: trustLevelChanges.toLevel,
          source: trustLevelChanges.source,
          changedAt: trustLevelChanges.changedAt,
        })
        .from(trustLevelChanges)
        .where(eq(trustLevelChanges.userId, userId))
        .orderBy(asc(trustLevelChanges.changedAt));
      return rows.map((r) => ({ ...r, changedAt: iso(r.changedAt) }));
    },
  },
  {
    table: "trust_level_changes",
    userColumn: "changed_by",
    onDelete: "keep",
    why: `a moderator's level changes to other users: ${KEEP_STAFF}`,
    exportAs: null,
  },
  {
    table: "filter_rules",
    userColumn: "created_by",
    onDelete: "keep",
    why: `filter rules a staff member wrote: ${KEEP_STAFF}`,
    exportAs: null,
  },
  {
    table: "settings",
    userColumn: "updated_by",
    onDelete: "keep",
    why: `settings an admin changed: ${KEEP_STAFF}`,
    exportAs: null,
  },
  {
    table: "game_session_exceptions",
    userColumn: "decided_by",
    onDelete: "keep",
    why: `session exceptions an admin decided: ${KEEP_STAFF}`,
    exportAs: null,
  },
  {
    table: "result_overrides",
    userColumn: "created_by",
    onDelete: "keep",
    why: `result overrides an admin made: ${KEEP_STAFF}`,
    exportAs: null,
  },
  {
    table: "result_overrides",
    userColumn: "revoked_by",
    onDelete: "keep",
    why: `result overrides an admin revoked: ${KEEP_STAFF}`,
    exportAs: null,
  },
  {
    table: "review_items",
    userColumn: "resolved_by",
    onDelete: "keep",
    why: `review items a staff member resolved: ${KEEP_STAFF}`,
    exportAs: null,
  },
  {
    table: "audit_log",
    userColumn: "actor_user_id",
    onDelete: "keep",
    why: "the audit log is append-only (a trigger refuses changes) and holds no personal fields (redactPersonal); its rows now name the tombstone",
    exportAs: null,
  },
  {
    table: "audit_log",
    userColumn: "impersonating_user_id",
    onDelete: "keep",
    why: "the audit log is append-only and records who an admin acted as; the id now names the tombstone",
    exportAs: null,
  },
];
