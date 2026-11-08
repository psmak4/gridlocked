/**
 * Age confirmation and the legal documents (DM 6.2, 6.8). We keep that a user
 * confirmed they are 16 or older, never a birth date.
 */
import {
  and,
  asc,
  desc,
  eq,
  exists,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import {
  auditLog,
  authAccounts,
  authSessions,
  authVerifications,
  emailOutbox,
  legalAcceptances,
  legalDocuments,
  leagues,
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
): Promise<void> {
  if (input.ageConfirmed !== true || input.accepted !== true) {
    throw new IdentityError("incomplete");
  }
  await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    const [user] = await t
      .select({ username: users.username })
      .from(users)
      .where(eq(users.id, input.userId))
      .for("update");
    if (!user) throw new IdentityError("unauthenticated");

    if (!user.username && input.username !== undefined) {
      const problem = await checkUsername(t, now, input.username, {
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

/** Re-acceptance: the user agrees to these documents. */
export async function acceptDocuments(
  db: Db,
  now: Date,
  input: { userId: string; documentIds: string[] },
): Promise<void> {
  if (input.documentIds.length === 0) return;
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

/**
 * Hard-deletes accounts that never confirmed their age and are older than
 * `olderThanDays`: the user and its sign-in rows, profile, acceptances and old
 * usernames. A user with a team, a league, or any audit row that names them
 * (as actor, as the one impersonated, or as the entity) is left alone, because
 * those rows must keep their user (DM 0.7). Returns how many were removed.
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
    .innerJoin(profiles, eq(profiles.userId, users.id))
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
    const deleted = await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      // The same test again under a lock: a sign-up finished since the read
      // is not removed.
      const [eligible] = await t
        .select({ id: users.id, email: users.email })
        .from(users)
        .innerJoin(profiles, eq(profiles.userId, users.id))
        .where(
          and(
            eq(users.id, id),
            isNull(profiles.ageConfirmedAt),
            sql`not ${exists(
              t
                .select({ one: sql`1` })
                .from(teams)
                .where(eq(teams.userId, id)),
            )}`,
            sql`not ${exists(
              t
                .select({ one: sql`1` })
                .from(leagues)
                .where(eq(leagues.ownerUserId, id)),
            )}`,
            sql`not ${exists(
              t
                .select({ one: sql`1` })
                .from(auditLog)
                .where(
                  or(
                    eq(auditLog.actorUserId, id),
                    eq(auditLog.impersonatingUserId, id),
                    eq(auditLog.entityId, id),
                  ),
                ),
            )}`,
          ),
        )
        .for("update", { of: users });
      if (!eligible) return false;

      await t.delete(authSessions).where(eq(authSessions.userId, id));
      await t.delete(authAccounts).where(eq(authAccounts.userId, id));
      // Reset and verification tokens hold the user's id or email.
      await t
        .delete(authVerifications)
        .where(
          or(
            eq(authVerifications.value, id),
            eq(authVerifications.identifier, eligible.email),
          ),
        );
      await t
        .delete(emailOutbox)
        .where(
          and(
            eq(emailOutbox.status, "queued"),
            sql`lower(${emailOutbox.toEmail}) = ${eligible.email.toLowerCase()}`,
          ),
        );
      await t.delete(legalAcceptances).where(eq(legalAcceptances.userId, id));
      await t.delete(usernameHistory).where(eq(usernameHistory.userId, id));
      await t.delete(profiles).where(eq(profiles.userId, id));
      await t.delete(users).where(inArray(users.id, [id]));
      return true;
    });
    if (deleted) {
      removed++;
      // Written after the delete, so this row does not name a user who is
      // still there (it would only be skipped on a later run, but be exact).
      await writeAudit(db, now, {
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
    }
  }
  return removed;
}
