/**
 * Age confirmation and the legal documents (DM 6.2, 6.8). We keep that a user
 * confirmed they are 16 or older, never a birth date.
 */
import { and, asc, desc, eq, exists, isNull, lt, or, sql } from "drizzle-orm";
import {
  authAccounts,
  authSessions,
  authVerifications,
  emailOutbox,
  legalAcceptances,
  legalDocuments,
  profiles,
  teams,
  usernameHistory,
  users,
  type LEGAL_DOCUMENT_KINDS,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { writeAudit } from "@/audit/log";
import { checkUsername } from "./usernames";
import { IdentityError } from "./viewer";

export type LegalDocument = typeof legalDocuments.$inferSelect;
type Kind = (typeof LEGAL_DOCUMENT_KINDS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Newest first: by publication, then by id so a tie is still an order. */
const newestFirst = [desc(legalDocuments.publishedAt), desc(legalDocuments.id)];

/** The latest version of each kind. */
export async function currentDocuments(db: Db): Promise<LegalDocument[]> {
  const all = await db
    .select()
    .from(legalDocuments)
    .orderBy(...newestFirst);
  const latest = new Map<Kind, LegalDocument>();
  for (const doc of all) if (!latest.has(doc.kind)) latest.set(doc.kind, doc);
  return [...latest.values()].sort((a, b) => a.kind.localeCompare(b.kind));
}

/**
 * The documents `userId` still has to accept (the latest of each kind). A kind
 * is settled once the user has accepted a version at or after the newest one
 * that `requires_reacceptance` (or the first, when none does), so a version
 * that doesn't require it never asks again those who accepted an earlier one.
 */
export async function pendingDocuments(
  db: Db,
  userId: string,
): Promise<LegalDocument[]> {
  const all = await db
    .select()
    .from(legalDocuments)
    .orderBy(...newestFirst);
  const accepted = new Set(
    (
      await db
        .select({ documentId: legalAcceptances.documentId })
        .from(legalAcceptances)
        .where(eq(legalAcceptances.userId, userId))
    ).map((row) => row.documentId),
  );
  const byKind = new Map<Kind, LegalDocument[]>();
  for (const doc of all)
    byKind.set(doc.kind, [...(byKind.get(doc.kind) ?? []), doc]);

  const pending: LegalDocument[] = [];
  for (const [, versions] of byKind) {
    // `versions` is newest first.
    const latest = versions[0]!;
    const floorIndex = versions.findIndex((v) => v.requiresReacceptance);
    const floor = floorIndex === -1 ? versions.length - 1 : floorIndex;
    const settled = versions
      .slice(0, floor + 1)
      .some((v) => accepted.has(v.id));
    if (!settled) pending.push(latest);
  }
  return pending.sort((a, b) => a.kind.localeCompare(b.kind));
}

/**
 * "Finish signing up" in one transaction: records the age confirmation and the
 * acceptance of every current document, and sets the username if there is none
 * (checked as `changeUsername` does). Safe to run again.
 */
export async function completeSignUp(
  db: Db,
  now: Date,
  input: {
    userId: string;
    ageConfirmed: true;
    accepted: true;
    username?: string;
  },
  // Only here so a test can stub the check; callers never pass it.
  deps: { check?: typeof checkUsername } = {},
): Promise<void> {
  const check = deps.check ?? checkUsername;
  if (input.ageConfirmed !== true || input.accepted !== true) {
    throw new IdentityError("incomplete");
  }
  try {
    await completeSignUpTransaction(db, now, input, check);
  } catch (error) {
    // Someone else claimed the name between the check and the write.
    if (isUniqueViolation(error)) throw new IdentityError("taken");
    throw error;
  }
}

async function completeSignUpTransaction(
  db: Db,
  now: Date,
  input: { userId: string; username?: string },
  check: typeof checkUsername,
): Promise<void> {
  await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const [user] = await t
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, input.userId))
      .for("update");
    if (!user) throw new IdentityError("unauthenticated");

    if (!user.username && input.username !== undefined) {
      const problem = await check(t, now, input.username, {
        userId: input.userId,
      });
      if (problem) throw new IdentityError(problem);
      await t
        .update(users)
        .set({
          username: input.username.toLowerCase(),
          displayUsername: input.username,
          updatedAt: now,
        })
        .where(eq(users.id, input.userId));
    }

    const confirmed = await t
      .update(profiles)
      .set({ ageConfirmedAt: now, updatedAt: now })
      .where(
        and(eq(profiles.userId, input.userId), isNull(profiles.ageConfirmedAt)),
      )
      .returning({ userId: profiles.userId });
    if (confirmed.length === 0) {
      const [profile] = await t
        .select({ userId: profiles.userId })
        .from(profiles)
        .where(eq(profiles.userId, input.userId));
      if (!profile) throw new IdentityError("unauthenticated");
    }

    const documents = await currentDocuments(t);
    if (documents.length > 0) {
      await t
        .insert(legalAcceptances)
        .values(
          documents.map((doc) => ({
            userId: input.userId,
            documentId: doc.id,
            acceptedAt: now,
          })),
        )
        .onConflictDoNothing();
    }
  });
}

/**
 * Re-acceptance: the user agrees to these documents. Each must be the current
 * version of its kind, otherwise `invalid_document`.
 */
export async function acceptDocuments(
  db: Db,
  now: Date,
  input: { userId: string; documentIds: string[] },
): Promise<void> {
  if (input.documentIds.length === 0) return;
  const current = new Set((await currentDocuments(db)).map((d) => d.id));
  if (!input.documentIds.every((id) => current.has(id))) {
    throw new IdentityError("invalid_document");
  }
  await db
    .insert(legalAcceptances)
    .values(
      input.documentIds.map((documentId) => ({
        userId: input.userId,
        documentId,
        acceptedAt: now,
      })),
    )
    .onConflictDoNothing();
}

const FOREIGN_KEY_VIOLATION = "23503";
const UNIQUE_VIOLATION = "23505";

/** Drivers wrap the Postgres error as a `cause`, so look down the chain. */
function hasPgCode(error: unknown, code: string): boolean {
  for (let e: unknown = error, i = 0; e && i < 5; i++, e = (e as Error).cause) {
    if ((e as { code?: unknown }).code === code) return true;
  }
  return false;
}
const isUniqueViolation = (error: unknown) =>
  hasPgCode(error, UNIQUE_VIOLATION);

/**
 * True when some row that must keep its user points at `id`: every RESTRICT
 * foreign key to `users` that the purge doesn't itself delete (DM 0.7).
 */
function isReferenced(t: Db, id: string) {
  const none = (table: string, column: string) =>
    sql`not exists (select 1 from ${sql.identifier(table)} where ${sql.identifier(column)} = ${id})`;
  return and(
    sql`not ${exists(
      t
        .select({ one: sql`1` })
        .from(teams)
        .where(eq(teams.userId, id)),
    )}`,
    none("leagues", "owner_user_id"),
    none("privacy_requests", "user_id"),
    none("trust_level_changes", "user_id"),
    none("trust_level_changes", "changed_by"),
    none("filter_rules", "created_by"),
    none("game_session_exceptions", "decided_by"),
    none("settings", "updated_by"),
    none("result_overrides", "created_by"),
    none("result_overrides", "revoked_by"),
    none("review_items", "resolved_by"),
    none("audit_log", "actor_user_id"),
    none("audit_log", "impersonating_user_id"),
    none("audit_log", "entity_id"),
  );
}

/**
 * Hard-deletes accounts that never confirmed their age and are older than
 * `olderThanDays`: the user and its sign-in rows, profile, acceptances and old
 * usernames. A user that any restricting foreign key names (a team, a league,
 * a privacy request, a trust change, a staff column, or an audit row) is left
 * alone in SQL. Each account is its own transaction; one that still hits a
 * foreign-key violation is skipped and logged by code, and the rest go on.
 * Returns how many were removed.
 */
export async function purgeIncompleteAccounts(
  db: Db,
  now: Date,
  { olderThanDays = 7 }: { olderThanDays?: number } = {},
): Promise<number> {
  const cutoff = new Date(now.getTime() - olderThanDays * DAY_MS);
  const candidates = await db
    .select({ id: users.id })
    .from(users)
    .leftJoin(profiles, eq(profiles.userId, users.id))
    .where(
      and(
        eq(users.role, "user"),
        isNull(profiles.ageConfirmedAt),
        lt(users.createdAt, cutoff),
      ),
    )
    .orderBy(asc(users.createdAt));

  let removed = 0;
  for (const { id } of candidates) {
    try {
      const deleted = await db.transaction(async (tx) => {
        const t = tx as unknown as Db;
        // Both rows locked, then the test again in a new statement (so a new
        // snapshot): a sign-up finished since the read is not removed.
        const [user] = await t
          .select({ id: users.id, email: users.email })
          .from(users)
          .where(and(eq(users.id, id), isReferenced(t, id)))
          .for("update");
        if (!user) return false;
        const [profile] = await t
          .select({ ageConfirmedAt: profiles.ageConfirmedAt })
          .from(profiles)
          .where(eq(profiles.userId, id))
          .for("update");
        if (profile && profile.ageConfirmedAt !== null) return false;

        await t.delete(authSessions).where(eq(authSessions.userId, id));
        await t.delete(authAccounts).where(eq(authAccounts.userId, id));
        // Reset and verification tokens hold the user's id or email.
        await t
          .delete(authVerifications)
          .where(
            or(
              eq(authVerifications.value, id),
              eq(authVerifications.identifier, user.email),
            ),
          );
        await t
          .delete(emailOutbox)
          .where(
            and(
              eq(emailOutbox.status, "queued"),
              sql`lower(${emailOutbox.toEmail}) = ${user.email.toLowerCase()}`,
            ),
          );
        await t.delete(legalAcceptances).where(eq(legalAcceptances.userId, id));
        await t.delete(usernameHistory).where(eq(usernameHistory.userId, id));
        await t.delete(profiles).where(eq(profiles.userId, id));
        await t.delete(users).where(eq(users.id, id));
        // `entity_id` has no foreign key, so this can name the deleted user.
        await writeAudit(t, now, {
          actorUserId: null,
          actorKind: "job",
          actorLabel: "purge incomplete accounts",
          action: "user.purge_incomplete",
          entityType: "user",
          entityId: id,
          before: null,
          after: { olderThanDays },
          reason: null,
          requestId: null,
        });
        return true;
      });
      if (deleted) removed++;
    } catch (error) {
      if (!hasPgCode(error, FOREIGN_KEY_VIOLATION)) throw error;
      console.error(
        `purge incomplete accounts: skipped (${FOREIGN_KEY_VIOLATION})`,
      );
    }
  }
  return removed;
}
