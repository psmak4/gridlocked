import { auditLog } from "@/db/schema";
import type { Db } from "@/db/types";
import { newId } from "@/lib/ids";

/** One `audit_log` row (DM 6.6), less what M5 adds (the user columns). */
export interface AuditEntry {
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

/**
 * Writes one audit row. Call it with the transaction that makes the change,
 * so the change and its record commit together (DM 0.4).
 */
export async function writeAudit(
  tx: Db,
  now: Date,
  entry: AuditEntry,
): Promise<void> {
  await tx.insert(auditLog).values({ id: newId(), ...entry, createdAt: now });
}
