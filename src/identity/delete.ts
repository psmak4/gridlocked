/**
 * Account deletion (DM 6.7): always anonymize, never delete the row. The user
 * asks with their username typed out, confirms by an emailed link (an hour)
 * or, with no verified address, by a sign-in in the last 10 minutes, and
 * `scrubAccount` then walks the personal-data registry in one transaction.
 *
 * The tombstone keeps its id, so every foreign key still resolves; it can't
 * sign in (no sign-in rows, and a `.invalid` address that Better Auth's hooks
 * refuse), and the old address and Discord account are free to start again.
 * The username stays held for 90 days (DM 6.3). Nothing here imports Better
 * Auth.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt } from "drizzle-orm";
import { writeAudit } from "@/audit/log";
import { authSessions, privacyRequests, profiles, users } from "@/db/schema";
import type { Db } from "@/db/types";
import { newId } from "@/lib/ids";
import { queueEmail } from "./email/outbox";
import type { EmailSender } from "./email/sender";
import { PERSONAL_DATA, type ScrubContext } from "./personal-data";
import { requireReason } from "@/staff/roster";
import { lockAdmins, requireAnotherAdmin, staffTransaction } from "./roles";
import { IdentityError, requireViewer, type Viewer } from "./viewer";

export { tombstoneEmail } from "./personal-data";

/** Who deleted the account: the user themself, or a staff member. */
export interface DeletionActor {
  kind: "user" | "moderator" | "admin";
  userId: string | null;
  label: string | null;
  requestId?: string;
}

/** The emailed link works for an hour. */
const CONFIRM_MS = 60 * 60 * 1000;
/** Without a verified address, the session must be this fresh. */
const FRESH_SIGN_IN_MS = 10 * 60 * 1000;

const hashToken = (token: string) =>
  createHash("sha256").update(token, "utf8").digest("hex");

const selfActor = (userId: string): DeletionActor => ({
  kind: "user",
  userId,
  label: null,
});

/**
 * The scrub, inside the caller's transaction. Admin rows are locked first, in
 * id order, as `setRole` does, so the last-admin check holds against a
 * demotion or another deletion at the same time. A profile already deleted is
 * left as it is.
 */
async function scrubInTransaction(
  tx: Db,
  now: Date,
  input: { userId: string; actor: DeletionActor; reason?: string | null },
): Promise<void> {
  await lockAdmins(tx);
  const [user] = await tx
    .select({
      id: users.id,
      role: users.role,
      email: users.email,
      username: users.username,
      displayUsername: users.displayUsername,
    })
    .from(users)
    .where(eq(users.id, input.userId))
    .for("update");
  if (!user) throw new IdentityError("no_such_user");
  if (user.role === "system") throw new IdentityError("role_reserved");
  // Locked too: an export job checks it under the same lock before it
  // records a file.
  const [profile] = await tx
    .select({ status: profiles.status })
    .from(profiles)
    .where(eq(profiles.userId, user.id))
    .for("update");
  if (profile?.status === "deleted") return;
  if (user.role === "admin") await requireAnotherAdmin(tx, now, user.id);

  const ctx: ScrubContext = {
    now,
    userId: user.id,
    email: user.email,
    username: user.username,
    displayUsername: user.displayUsername,
  };
  for (const entry of PERSONAL_DATA) {
    if (entry.scrub) await entry.scrub(tx, ctx);
  }
  if (!profile) {
    // A profile is made on first sight; one that never was is made deleted.
    await tx.insert(profiles).values({
      userId: user.id,
      status: "deleted",
      avatarSeed: user.id,
      createdAt: now,
      updatedAt: now,
    });
  }
  // Nothing personal: no address, no name, only what changed.
  await writeAudit(tx, now, {
    actorUserId: input.actor.userId,
    actorKind: input.actor.kind,
    actorLabel: input.actor.label,
    action: "user.delete",
    entityType: "user",
    entityId: user.id,
    before: { role: user.role, status: profile?.status ?? null },
    after: { role: "user", status: "deleted" },
    reason: input.reason?.trim() || null,
    requestId: input.actor.requestId ?? null,
  });
}

/**
 * Anonymizes the account in one transaction, in registry order (DM 6.7), with
 * the audit `user.delete`. Refuses the `system` user (`role_reserved`) and
 * the last active admin (`last_admin`). Running it again changes nothing.
 * Staff callers check the actor themselves (`requireStaff`); a moderator may
 * delete, e.g. an under-16 account, with a reason.
 */
export async function scrubAccount(
  db: Db,
  now: Date,
  input: { userId: string; actor: DeletionActor; reason?: string | null },
): Promise<void> {
  // A staff deletion is a staff action, so it says why, as a ban does.
  // M8 adds the rank rule (a moderator can't delete staff) with its screens;
  // until then the caller checks `requireStaff` and the target.
  const reason =
    input.actor.kind === "user"
      ? input.reason
      : requireReason(input.reason ?? "");
  await staffTransaction(db, (tx) =>
    scrubInTransaction(tx, now, { ...input, reason }),
  );
}

/**
 * The user asks to delete their account, typing their username (any case),
 * or their email address if they never chose a username. `deps.baseUrl` is
 * the site's address, for the link.
 * With a verified address, a one-hour token goes out as `delete_confirm` and
 * only its hash is kept; a new request replaces an older one's link. With
 * none, a sign-in in the last 10 minutes is the confirmation, and the account
 * goes at once (`sign_in_again` otherwise). Refused for an impersonated
 * session (`read_only`), a wrong name (`wrong_username`), `system` and the
 * last active admin.
 */
export async function requestDeletion(
  db: Db,
  now: Date,
  input: { viewer: Viewer | null; typedUsername: string },
  deps: { sender: EmailSender | null; baseUrl: string },
): Promise<{ confirm: "email" | "fresh_sign_in" }> {
  const viewer = requireViewer(input.viewer);
  if (viewer.impersonatedBy !== null) throw new IdentityError("read_only");

  const outcome = await staffTransaction(db, async (tx) => {
    await lockAdmins(tx);
    const [user] = await tx
      .select({
        role: users.role,
        email: users.email,
        emailVerified: users.emailVerified,
        username: users.username,
        status: profiles.status,
      })
      .from(users)
      .leftJoin(profiles, eq(profiles.userId, users.id))
      .where(eq(users.id, viewer.userId))
      .for("update", { of: users });
    if (!user) throw new IdentityError("unauthenticated");
    if (user.role === "system") throw new IdentityError("role_reserved");
    if (user.status === "deleted") throw new IdentityError("inactive");
    // The username, or the email address for an account that never chose
    // one; either in any case.
    const typed = input.typedUsername.trim().toLowerCase();
    const expected = (user.username ?? user.email).trim().toLowerCase();
    if (typed === "" || typed !== expected) {
      throw new IdentityError("wrong_username");
    }
    if (user.role === "admin") {
      await requireAnotherAdmin(tx, now, viewer.userId);
    }

    if (user.emailVerified) {
      await tx
        .update(privacyRequests)
        .set({
          status: "failed",
          confirmTokenHash: null,
          confirmExpiresAt: null,
        })
        .where(
          and(
            eq(privacyRequests.userId, viewer.userId),
            eq(privacyRequests.kind, "delete"),
            eq(privacyRequests.status, "pending"),
          ),
        );
      const token = randomBytes(32).toString("base64url");
      await tx.insert(privacyRequests).values({
        id: newId(),
        userId: viewer.userId,
        kind: "delete",
        status: "pending",
        requestedAt: now,
        confirmTokenHash: hashToken(token),
        confirmExpiresAt: new Date(now.getTime() + CONFIRM_MS),
      });
      return { confirm: "email" as const, token, email: user.email };
    }

    const [session] = await tx
      .select({ createdAt: authSessions.createdAt })
      .from(authSessions)
      .where(
        and(
          eq(authSessions.id, viewer.sessionId),
          eq(authSessions.userId, viewer.userId),
        ),
      );
    if (
      !session ||
      now.getTime() - session.createdAt.getTime() > FRESH_SIGN_IN_MS
    ) {
      throw new IdentityError("sign_in_again");
    }
    await tx.insert(privacyRequests).values({
      id: newId(),
      userId: viewer.userId,
      kind: "delete",
      status: "completed",
      requestedAt: now,
      completedAt: now,
    });
    await scrubInTransaction(tx, now, {
      userId: viewer.userId,
      actor: selfActor(viewer.userId),
    });
    return { confirm: "fresh_sign_in" as const };
  });

  if (outcome.confirm === "email") {
    const url = `${deps.baseUrl}/account/delete/confirm?token=${encodeURIComponent(outcome.token)}`;
    await queueEmail(
      db,
      now,
      {
        to: outcome.email,
        template: "delete_confirm",
        payload: { url },
        expiresAt: new Date(now.getTime() + CONFIRM_MS),
      },
      deps.sender,
    );
  }
  return { confirm: outcome.confirm };
}

/**
 * The emailed link: deletes the account if the token is the latest one asked
 * for and less than an hour old, using it up in the same transaction as the
 * scrub. Anything else changes nothing and is `invalid_link`.
 */
export async function confirmDeletion(
  db: Db,
  now: Date,
  { token }: { token: string },
): Promise<void> {
  if (typeof token !== "string" || token.length === 0) {
    throw new IdentityError("invalid_link");
  }
  const hash = hashToken(token);
  await staffTransaction(db, async (tx) => {
    const [claimed] = await tx
      .update(privacyRequests)
      .set({
        status: "completed",
        completedAt: now,
        confirmTokenHash: null,
        confirmExpiresAt: null,
      })
      .where(
        and(
          eq(privacyRequests.kind, "delete"),
          eq(privacyRequests.status, "pending"),
          eq(privacyRequests.confirmTokenHash, hash),
          gt(privacyRequests.confirmExpiresAt, now),
        ),
      )
      .returning({ userId: privacyRequests.userId });
    if (!claimed) throw new IdentityError("invalid_link");
    await scrubInTransaction(tx, now, {
      userId: claimed.userId,
      actor: selfActor(claimed.userId),
    });
  });
}
