import { and, eq, isNull } from "drizzle-orm";
import { writeAudit } from "@/audit/log";
import { resultOverrides, results, sessions } from "@/db/schema";
import type { Db } from "@/db/types";
import { addOverride, type ResultFields } from "@/results/overrides";
import { audit, requireReason, type StaffActor } from "./roster";
import {
  revalidateEvent,
  type SessionMove,
  type StaffDeps,
} from "./revalidate";

// A staff correction to one driver's result in one session (DM 2.6, HLD
// §4.3): a `patch` override over the provider row, for provider data that
// is wrong and stays wrong. Runs through `pnpm staff override` until M8.

/**
 * Stands in for `result_overrides.created_by` until M5 adds users: the
 * column is a uuid, and who acted is in the audit row's `actor_label`.
 */
export const STAFF_PLACEHOLDER_USER_ID = "00000000-0000-0000-0000-000000000000";

/** JSON with sorted keys, so two field sets compare by content. */
function canonical(fields: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(fields)
      .sort()
      .map((k) => [k, fields[k]]),
  );
}

/**
 * Sets `fields` on `driverId`'s row in `sessionId`, with a reason, and writes
 * the audit row in the same transaction. An active override for that driver
 * is replaced (revoke-and-replace, in `addOverride`). Running it again with
 * the same fields changes nothing and writes no audit row (`changed: false`).
 * Then the event is checked again, so the session moves at once.
 *
 * Refuses a blank reason, invalid fields, a driver with no provider row in
 * the session and a `final` session (`SessionFinalError`), writing nothing.
 */
export async function overrideResult(
  db: Db,
  now: Date,
  input: {
    sessionId: string;
    driverId: string;
    fields: ResultFields;
    reason: string;
    actor: StaffActor;
  },
  deps: StaffDeps = {},
): Promise<{ changed: boolean; sessions: SessionMove[] }> {
  const reason = requireReason(input.reason);
  const { sessionId, driverId, fields } = input;

  const [session] = await db
    .select({ eventId: sessions.eventId })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  if (!session) throw new Error(`no session ${sessionId}`);

  const changed = await db.transaction(async (tx) => {
    // A patch sets fields over a provider row; with no row it would set none.
    const [row] = await tx
      .select({ driverId: results.driverId })
      .from(results)
      .where(
        and(eq(results.sessionId, sessionId), eq(results.driverId, driverId)),
      );
    if (!row) {
      throw new Error(
        `driver ${driverId} has no result in session ${sessionId}`,
      );
    }
    const [active] = await tx
      .select()
      .from(resultOverrides)
      .where(
        and(
          eq(resultOverrides.sessionId, sessionId),
          eq(resultOverrides.driverId, driverId),
          isNull(resultOverrides.revokedAt),
        ),
      );
    const current = active ? (active.fields as Record<string, unknown>) : null;
    if (
      active?.kind === "patch" &&
      current &&
      canonical(current) === canonical(fields)
    ) {
      return false;
    }
    const id = await addOverride(tx, now, {
      sessionId,
      driverId,
      kind: "patch",
      fields,
      reason,
      createdBy: STAFF_PLACEHOLDER_USER_ID,
    });
    await writeAudit(tx, now, {
      ...audit(input.actor, reason),
      action: "result_override.create",
      entityType: "result_override",
      entityId: id,
      before: active
        ? { overrideId: active.id, kind: active.kind, fields: current }
        : null,
      after: { sessionId, driverId, kind: "patch", fields },
    });
    return true;
  });

  return {
    changed,
    sessions: await revalidateEvent(db, now, session.eventId, deps),
  };
}
