import { auditLog } from "@/db/schema";
import type { Db } from "@/db/types";
import { newId } from "@/lib/ids";

/** One `audit_log` row (DM 6.6), less its id and timestamp. */
export interface AuditEntry {
  /** The signed-in user who acted, when there is one. */
  actorUserId?: string | null;
  /** The user an admin was acting as, when impersonating. */
  impersonatingUserId?: string | null;
  actorKind: "admin" | "moderator" | "user" | "system" | "job";
  actorLabel: string | null;
  action: string;
  entityType: string;
  entityId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  requestId: string | null;
}

const PERSONAL_KEYS = new Set([
  "email",
  "ip",
  "ipAddress",
  "userAgent",
  "name",
]);
const REDACTED = "[redacted]";

/**
 * A copy of `value` with every `email`, `ip`, `ipAddress`, `userAgent` and
 * `name` key, at any depth, set to "[redacted]". The audit log is append-only,
 * so personal data must not get in (DM 6.6).
 */
export function redactPersonal<T>(value: T): T {
  if (Array.isArray(value)) return value.map(redactPersonal) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        PERSONAL_KEYS.has(key) ? REDACTED : redactPersonal(item),
      ]),
    ) as T;
  }
  return value;
}

/**
 * Writes one audit row and returns its id. Call it with the transaction that
 * makes the change, so the change and its record commit together (DM 0.4).
 */
export async function writeAudit(
  tx: Db,
  now: Date,
  entry: AuditEntry,
): Promise<string> {
  const id = newId();
  await tx.insert(auditLog).values({
    id,
    ...entry,
    before: redactPersonal(entry.before),
    after: redactPersonal(entry.after),
    createdAt: now,
  });
  return id;
}
