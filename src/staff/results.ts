import { and, eq, isNull } from "drizzle-orm";
import { writeAudit } from "@/audit/log";
import {
  type CLASSIFICATIONS,
  eventEntries,
  resultOverrides,
  results,
  sessions,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { SYSTEM_USER_ID } from "@/identity/system";
import { addOverride, type ResultFields } from "@/results/overrides";
import { audit, requireReason, type StaffActor } from "./roster";
import {
  revalidateEvent,
  type SessionMove,
  type StaffDeps,
} from "./revalidate";

// A staff correction to one driver's result in one session (DM 2.6, HLD
// §4.3): a `patch` override over the provider row, for provider data that
// is wrong and stays wrong, or an `insert` for a driver the provider left out.
// Run through `pnpm staff override` and `pnpm staff insert` until M8.

/** `results.provider_status` of an inserted row: no provider said anything. */
const INSERTED_STATUS = "Entered by staff";

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
 * the session (that is an `insertResult`) and a `final` session
 * (`SessionFinalError`), writing nothing.
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
        `driver ${driverId} has no result in session ${sessionId}: insert it`,
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
      createdBy: SYSTEM_USER_ID,
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

/**
 * Adds the result of a driver the provider left out of `sessionId` (Jolpica
 * lists nobody with no Q1 time, DM 2.13), with a reason, and writes the audit
 * row in the same transaction: an `insert` override, which `effective_results`
 * reads as a row with no Q times, so a qualifying insert is "no time set"
 * (DM 2.4). A different active insert for that driver is replaced. Running it
 * again with the same values changes nothing and writes no audit row
 * (`changed: false`). Then the event is checked again, so the session moves at
 * once: the last missing driver takes it from `awaiting` to `provisional`.
 *
 * Refuses a blank reason, a driver with a provider row in the session (that is
 * an `overrideResult`), a driver not entered at the event and a `final` session
 * (`SessionFinalError`), writing nothing.
 */
export async function insertResult(
  db: Db,
  now: Date,
  input: {
    sessionId: string;
    driverId: string;
    constructorId: string;
    carNumber: number;
    /** Null for a classification with no place, such as `did_not_start`. */
    position: number | null;
    classification: (typeof CLASSIFICATIONS)[number];
    reason: string;
    actor: StaffActor;
  },
  deps: StaffDeps = {},
): Promise<{ changed: boolean; sessions: SessionMove[] }> {
  const reason = requireReason(input.reason);
  const { sessionId, driverId, position } = input;
  const fields: ResultFields = {
    constructor_id: input.constructorId,
    car_number: input.carNumber,
    position,
    classification: input.classification,
    provider_status: INSERTED_STATUS,
    provider_position_text: position === null ? "-" : String(position),
  };

  const [session] = await db
    .select({ eventId: sessions.eventId })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  if (!session) throw new Error(`no session ${sessionId}`);

  const changed = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ driverId: results.driverId })
      .from(results)
      .where(
        and(eq(results.sessionId, sessionId), eq(results.driverId, driverId)),
      );
    if (row) {
      throw new Error(
        `driver ${driverId} already has a result in session ${sessionId}: override it`,
      );
    }
    const [entry] = await tx
      .select({ driverId: eventEntries.driverId })
      .from(eventEntries)
      .where(
        and(
          eq(eventEntries.eventId, session.eventId),
          eq(eventEntries.driverId, driverId),
        ),
      );
    if (!entry) {
      throw new Error(
        `driver ${driverId} isn't entered at the event of session ${sessionId}`,
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
      active?.kind === "insert" &&
      current &&
      canonical(current) === canonical(fields)
    ) {
      return false;
    }
    const id = await addOverride(tx, now, {
      sessionId,
      driverId,
      kind: "insert",
      fields,
      reason,
      createdBy: SYSTEM_USER_ID,
    });
    await writeAudit(tx, now, {
      ...audit(input.actor, reason),
      action: "result_override.create",
      entityType: "result_override",
      entityId: id,
      before: active
        ? { overrideId: active.id, kind: active.kind, fields: current }
        : null,
      after: { sessionId, driverId, kind: "insert", fields },
    });
    return true;
  });

  return {
    changed,
    sessions: await revalidateEvent(db, now, session.eventId, deps),
  };
}
