/**
 * Moderation actions (DM 5.9; HLD §7.4): the other half of the queue. Each
 * action is one transaction that changes the content or the account, writes
 * `mod_actions` (which the user sees) and `audit_log` (with the reason), and,
 * when it answers a queue item, resolves that item. Resolving checks the
 * item's `version`, so two moderators can't both decide it (DM 0.7).
 *
 * `ban` and `unban` stay with Better Auth's admin plugin; `set_trust_level`
 * has its own path (identity/trust). Neither is taken here.
 */
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { writeAudit } from "@/audit/log";
import {
  categories,
  chatMessages,
  modActions,
  modQueueItems,
  posts,
  reports,
  threads,
  userRestrictions,
  users,
  type ModAction,
  type PostStatus,
  type RestrictionKind,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { IdentityError } from "@/identity/identity-error";
import { SYSTEM_USER_ID } from "@/identity/system";
import type { Viewer } from "@/identity/viewer";
import { newId } from "@/lib/ids";

/** The actions M7 takes, and what each one acts on. */
const ACTS_ON = {
  remove: ["post", "thread", "chat_message"],
  restore: ["post", "thread", "chat_message"],
  lock: ["thread"],
  unlock: ["thread"],
  pin: ["thread"],
  unpin: ["thread"],
  move: ["thread"],
  retitle: ["thread"],
  warn: ["user"],
  mute: ["user"],
  unmute: ["user"],
  chat_ban: ["user"],
} as const satisfies Partial<Record<ModAction, readonly string[]>>;

export type M7ModAction = keyof typeof ACTS_ON;
export const M7_MOD_ACTIONS = Object.keys(ACTS_ON) as M7ModAction[];
export type ModTargetType = "post" | "thread" | "chat_message" | "user";

/** Who acts: a signed-in moderator or admin, or the staff workflow. */
export type ModActor = {
  /** Null for the staff workflow, whose login goes in `label`. */
  userId: string | null;
  kind: "admin" | "moderator";
  label: string | null;
  requestId?: string;
};

/** A signed-in staff member as an actor; anyone else is refused. */
export function staffActor(viewer: Viewer | null): ModActor {
  if (!viewer || (viewer.role !== "moderator" && viewer.role !== "admin")) {
    throw new IdentityError("forbidden");
  }
  return { userId: viewer.userId, kind: viewer.role, label: null };
}

export type ModerateInput = {
  action: M7ModAction;
  targetType: ModTargetType;
  targetId: string;
  reason: string;
  /** For `mute` and `chat_ban`: null or absent until lifted. */
  until?: Date | null;
  /** The queue item this decides, with the version the moderator saw. */
  queueItemId?: string;
  version?: number;
  /** For `retitle`: the new spoiler-safe title. */
  title?: string;
  /** For `move`. */
  categoryId?: string;
};

export type ModerateRefusal = {
  ok: false;
  error: "not_found" | "invalid" | "version_conflict";
};

export type ModerateResult =
  | {
      ok: true;
      actionId: string;
      /** False when the content was already that way. */
      changed: boolean;
    }
  | ModerateRefusal;

const refused = (error: ModerateRefusal["error"]): ModerateRefusal => ({
  ok: false,
  error,
});

/** Thrown inside the transaction to roll it back with a refusal. */
class Refused extends Error {
  constructor(readonly refusal: ModerateRefusal) {
    super(refusal.error);
  }
}

type Change = {
  targetUserId: string | null;
  changed: boolean;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};

const SHOWN_AGAIN: PostStatus[] = [
  "removed",
  "hidden_by_flags",
  "pending_review",
];

async function changePost(
  db: Db,
  input: ModerateInput,
  action: "remove" | "restore",
): Promise<Change> {
  const [post] = await db
    .select({
      status: posts.status,
      authorUserId: posts.authorUserId,
      isOpening: posts.isOpening,
      threadId: posts.threadId,
    })
    .from(posts)
    .where(eq(posts.id, input.targetId))
    .for("update");
  if (!post) throw new Refused(refused("not_found"));
  const next: PostStatus | null =
    action === "remove"
      ? post.status === "deleted_by_author" || post.status === "removed"
        ? null
        : "removed"
      : SHOWN_AGAIN.includes(post.status)
        ? "visible"
        : null;
  const base = { targetUserId: post.authorUserId };
  if (!next) return { ...base, changed: false, before: null, after: null };
  await db
    .update(posts)
    .set({ status: next })
    .where(eq(posts.id, input.targetId));
  if (!post.isOpening && (post.status === "visible") !== (next === "visible")) {
    await db
      .update(threads)
      .set({
        replyCount:
          next === "visible"
            ? sql`${threads.replyCount} + 1`
            : sql`greatest(${threads.replyCount} - 1, 0)`,
      })
      .where(eq(threads.id, post.threadId));
  }
  return {
    ...base,
    changed: true,
    before: { status: post.status },
    after: { status: next },
  };
}

async function changeChat(
  db: Db,
  input: ModerateInput,
  action: "remove" | "restore",
): Promise<Change> {
  const [row] = await db
    .select({
      status: chatMessages.status,
      authorUserId: chatMessages.authorUserId,
    })
    .from(chatMessages)
    .where(eq(chatMessages.id, input.targetId));
  if (!row) throw new Refused(refused("not_found"));
  const next = action === "remove" ? "removed" : "visible";
  const base = { targetUserId: row.authorUserId };
  if (row.status === next)
    return { ...base, changed: false, before: null, after: null };
  await db
    .update(chatMessages)
    .set({ status: next })
    .where(eq(chatMessages.id, input.targetId));
  return {
    ...base,
    changed: true,
    before: { status: row.status },
    after: { status: next },
  };
}

async function changeThread(db: Db, input: ModerateInput): Promise<Change> {
  const [thread] = await db
    .select({
      status: threads.status,
      pinned: threads.pinned,
      categoryId: threads.categoryId,
      spoilerSafeTitle: threads.spoilerSafeTitle,
      authorUserId: threads.authorUserId,
    })
    .from(threads)
    .where(eq(threads.id, input.targetId))
    .for("update");
  if (!thread) throw new Refused(refused("not_found"));

  let set: Partial<typeof threads.$inferInsert> = {};
  let before: Record<string, unknown> = {};
  switch (input.action) {
    case "remove":
      if (thread.status !== "removed") set = { status: "removed" };
      before = { status: thread.status };
      break;
    case "restore":
      if (thread.status === "removed") set = { status: "open" };
      before = { status: thread.status };
      break;
    case "lock":
      if (thread.status === "open") set = { status: "locked" };
      before = { status: thread.status };
      break;
    case "unlock":
      if (thread.status === "locked") set = { status: "open" };
      before = { status: thread.status };
      break;
    case "pin":
    case "unpin": {
      const pinned = input.action === "pin";
      if (thread.pinned !== pinned) set = { pinned };
      before = { pinned: thread.pinned };
      break;
    }
    case "move": {
      if (!input.categoryId) throw new Refused(refused("invalid"));
      const [category] = await db
        .select({ status: categories.status })
        .from(categories)
        .where(eq(categories.id, input.categoryId));
      if (!category || category.status !== "active")
        throw new Refused(refused("not_found"));
      if (thread.categoryId !== input.categoryId)
        set = { categoryId: input.categoryId };
      before = { categoryId: thread.categoryId };
      break;
    }
    case "retitle": {
      // Only the spoiler-safe title (HLD §7.3): the author's title stays.
      const title = input.title?.trim() ?? "";
      if (title.length === 0 || title.length > 120)
        throw new Refused(refused("invalid"));
      if (thread.spoilerSafeTitle !== title) set = { spoilerSafeTitle: title };
      before = { spoilerSafeTitle: thread.spoilerSafeTitle };
      break;
    }
    default:
      throw new Refused(refused("invalid"));
  }
  const base = { targetUserId: thread.authorUserId };
  if (Object.keys(set).length === 0)
    return { ...base, changed: false, before: null, after: null };
  await db.update(threads).set(set).where(eq(threads.id, input.targetId));
  return { ...base, changed: true, before, after: set };
}

const RESTRICTS: Partial<Record<M7ModAction, RestrictionKind>> = {
  mute: "mute",
  chat_ban: "chat_ban",
};

async function changeUser(
  db: Db,
  now: Date,
  actor: ModActor,
  input: ModerateInput,
): Promise<Change> {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, input.targetId));
  if (!user) throw new Refused(refused("not_found"));
  const base = { targetUserId: user.id };
  const kind = RESTRICTS[input.action];
  if (kind) {
    if (input.until && input.until.getTime() <= now.getTime())
      throw new Refused(refused("invalid"));
    // The workflow has no user row: the system user stands in for it.
    const createdBy = actor.userId ?? SYSTEM_USER_ID;
    await db.insert(userRestrictions).values({
      id: newId(),
      userId: user.id,
      kind,
      until: input.until ?? null,
      reason: input.reason.trim(),
      createdBy,
      createdAt: now,
    });
    return {
      ...base,
      changed: true,
      before: null,
      after: { kind, until: input.until?.toISOString() ?? null },
    };
  }
  if (input.action === "unmute") {
    // Lifts what keeps them quiet: a mute and a chat ban.
    const lifted = await db
      .update(userRestrictions)
      .set({ liftedAt: now })
      .where(
        and(
          eq(userRestrictions.userId, user.id),
          inArray(userRestrictions.kind, ["mute", "chat_ban"]),
          isNull(userRestrictions.liftedAt),
        ),
      )
      .returning({ kind: userRestrictions.kind });
    return {
      ...base,
      changed: lifted.length > 0,
      before:
        lifted.length > 0 ? { restrictions: lifted.map((l) => l.kind) } : null,
      after: null,
    };
  }
  // `warn` changes nothing but the record (Task 13 tells the user).
  return { ...base, changed: true, before: null, after: null };
}

/**
 * Takes one moderation action. Refusals: `invalid` for an action on the
 * wrong kind of thing, a blank reason or a missing field; `not_found`; and
 * `version_conflict` when the queue item was decided or changed since the
 * moderator looked.
 */
export async function moderate(
  db: Db,
  now: Date,
  actor: ModActor,
  input: ModerateInput,
): Promise<ModerateResult> {
  const reason = input.reason.trim();
  const targets = ACTS_ON[input.action] as readonly string[] | undefined;
  if (!targets || !targets.includes(input.targetType) || reason.length === 0)
    return refused("invalid");
  if (input.queueItemId !== undefined && input.version === undefined)
    return refused("invalid");

  try {
    return await db.transaction(async (tx): Promise<ModerateResult> => {
      const t = tx as unknown as Db;
      let change: Change;
      if (input.targetType === "user") {
        change = await changeUser(t, now, actor, input);
      } else if (input.targetType === "thread") {
        change = await changeThread(t, input);
      } else if (input.targetType === "post") {
        change = await changePost(
          t,
          input,
          input.action as "remove" | "restore",
        );
      } else {
        change = await changeChat(
          t,
          input,
          input.action as "remove" | "restore",
        );
      }

      if (input.queueItemId !== undefined) {
        const decided = await t
          .update(modQueueItems)
          .set({
            // "Keep it" (a restore) closes the reports without action.
            status: input.action === "restore" ? "dismissed" : "actioned",
            resolvedBy: actor.userId,
            resolvedAt: now,
            resolution: input.action,
            version: sql`${modQueueItems.version} + 1`,
          })
          .where(
            and(
              eq(modQueueItems.id, input.queueItemId),
              eq(modQueueItems.version, input.version!),
              eq(modQueueItems.status, "open"),
            ),
          )
          .returning({ id: modQueueItems.id });
        if (decided.length === 0)
          throw new Refused(refused("version_conflict"));
        // Logged-out reporters' addresses go at resolution (DM 5.10).
        await t
          .update(reports)
          .set({ reporterContact: null })
          .where(eq(reports.queueItemId, input.queueItemId));
      }

      const actionId = newId();
      await t.insert(modActions).values({
        id: actionId,
        moderatorUserId: actor.userId,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        targetUserId: change.targetUserId,
        reason,
        until: input.until ?? null,
        queueItemId: input.queueItemId ?? null,
        createdAt: now,
      });
      await writeAudit(t, now, {
        actorUserId: actor.userId,
        actorKind: actor.kind,
        actorLabel: actor.label,
        action: `moderation.${input.action}`,
        entityType: input.targetType,
        entityId: input.targetId,
        before: change.before,
        after: change.after,
        reason,
        requestId: actor.requestId ?? null,
      });
      return { ok: true, actionId, changed: change.changed };
    });
  } catch (error) {
    if (error instanceof Refused) return error.refusal;
    throw error;
  }
}

/** One action against the user, as "Actions on your account" lists it. */
export type AccountAction = {
  action: ModAction;
  targetType: string;
  reason: string;
  until: string | null;
  createdAt: string;
};

/**
 * The actions taken against a user, newest first (DM 5.9: users see them).
 * Who took them isn't shown.
 */
export async function accountActions(
  db: Db,
  userId: string,
  limit = 20,
): Promise<AccountAction[]> {
  const rows = await db
    .select({
      action: modActions.action,
      targetType: modActions.targetType,
      reason: modActions.reason,
      until: modActions.until,
      createdAt: modActions.createdAt,
    })
    .from(modActions)
    .where(eq(modActions.targetUserId, userId))
    .orderBy(desc(modActions.createdAt), desc(modActions.id))
    .limit(limit);
  return rows.map((r) => ({
    ...r,
    until: r.until?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }));
}
