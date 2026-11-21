/**
 * The audit log screen's reads (M8 Task 4). Read-only: nothing here, or
 * anywhere, edits or deletes an audit row (DM 6.6). Pages of 50, newest
 * first, by id (UUIDv7, so by time).
 */
import { aliasedTable, and, desc, eq, inArray, lt, or } from "drizzle-orm";
import { auditLog, profiles, users } from "@/db/schema";
import type { Db } from "@/db/types";
import { AUDIT_ACTIONS, actionsIn, type AuditGroup } from "./actions";

export const AUDIT_PAGE_SIZE = 50;

export type AuditRow = {
  id: string;
  /** ISO. */
  when: string;
  /** The staff member's username, the workflow's label, "Job" or "deleted user". */
  who: string;
  /** The action's label. */
  what: string;
  /** What it was done to: a username, or the kind of thing. */
  on: string;
  /** Each changed field, "field: old → new". */
  change: string[];
  reason: string | null;
};

export type AuditPage = { rows: AuditRow[]; next: string | null };

const DELETED = "deleted user";

/** A value as the screen shows it. */
function shown(value: unknown): string {
  if (value === null || value === undefined) return "none";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/** The changed fields only, in the order the row lists them. */
export function changedFields(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
): string[] {
  const keys = [
    ...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]),
  ];
  const out: string[] = [];
  for (const key of keys) {
    const old = before?.[key];
    const now = after?.[key];
    if (before === null) {
      out.push(`${key}: ${shown(now)}`);
    } else if (JSON.stringify(old) !== JSON.stringify(now)) {
      out.push(`${key}: ${shown(old)} → ${shown(now)}`);
    }
  }
  return out;
}

const actor = aliasedTable(profiles, "actor");
const target = aliasedTable(profiles, "target");
const targetUser = aliasedTable(users, "target_user");

export async function auditPage(
  db: Db,
  input: {
    /** "jobs" for jobs and the system, or a staff member's user id. */
    who?: "jobs" | string;
    group?: AuditGroup;
    /** The cursor: the last id of the page before. */
    before?: string;
  },
): Promise<AuditPage> {
  const where = and(
    input.who === "jobs"
      ? or(eq(auditLog.actorKind, "job"), eq(auditLog.actorKind, "system"))
      : input.who
        ? eq(auditLog.actorUserId, input.who)
        : undefined,
    input.group ? inArray(auditLog.action, actionsIn(input.group)) : undefined,
    input.before ? lt(auditLog.id, input.before) : undefined,
  );
  const found = await db
    .select({
      id: auditLog.id,
      createdAt: auditLog.createdAt,
      actorKind: auditLog.actorKind,
      actorLabel: auditLog.actorLabel,
      actorUserId: auditLog.actorUserId,
      actorName: users.username,
      actorStatus: actor.status,
      action: auditLog.action,
      entityType: auditLog.entityType,
      entityId: auditLog.entityId,
      targetStatus: target.status,
      targetName: targetUser.username,
      before: auditLog.before,
      after: auditLog.after,
      reason: auditLog.reason,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .leftJoin(actor, eq(actor.userId, auditLog.actorUserId))
    .leftJoin(
      targetUser,
      and(
        eq(auditLog.entityType, "user"),
        eq(targetUser.id, auditLog.entityId),
      ),
    )
    .leftJoin(
      target,
      and(
        eq(auditLog.entityType, "user"),
        eq(target.userId, auditLog.entityId),
      ),
    )
    .where(where)
    .orderBy(desc(auditLog.id))
    .limit(AUDIT_PAGE_SIZE + 1);

  const page = found.slice(0, AUDIT_PAGE_SIZE);
  return {
    rows: page.map((r) => ({
      id: r.id,
      when: r.createdAt.toISOString(),
      who: r.actorLabel
        ? r.actorLabel
        : r.actorKind === "job" || r.actorKind === "system"
          ? "Job"
          : r.actorStatus === "deleted" || !r.actorName
            ? DELETED
            : r.actorName,
      what:
        AUDIT_ACTIONS[r.action as keyof typeof AUDIT_ACTIONS]?.label ??
        r.action,
      on:
        r.entityType === "user"
          ? r.targetStatus === "deleted" || !r.targetName
            ? DELETED
            : r.targetName
          : r.entityType.replaceAll("_", " "),
      change: changedFields(
        r.before as Record<string, unknown> | null,
        r.after as Record<string, unknown> | null,
      ),
      reason: r.reason,
    })),
    next: found.length > AUDIT_PAGE_SIZE ? page[page.length - 1]!.id : null,
  };
}

/** The staff members the "who" filter offers: anyone who has acted as staff. */
export async function auditActors(
  db: Db,
): Promise<{ userId: string; username: string }[]> {
  const rows = await db
    .selectDistinct({ userId: users.id, username: users.username })
    .from(auditLog)
    .innerJoin(users, eq(users.id, auditLog.actorUserId))
    .innerJoin(profiles, eq(profiles.userId, users.id))
    .where(
      and(
        inArray(auditLog.actorKind, ["admin", "moderator"]),
        eq(profiles.status, "active"),
      ),
    );
  return rows
    .flatMap((r) =>
      r.username ? [{ userId: r.userId, username: r.username }] : [],
    )
    .sort((a, b) => a.username.localeCompare(b.username));
}
