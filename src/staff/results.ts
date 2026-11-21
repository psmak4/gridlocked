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
import {
  addOverride,
  type OnFinal,
  type ResultFields,
  revokeOverride as revokeOverrideRow,
} from "@/results/overrides";
import { StaffError } from "./errors";
import {
  CLASSIFICATION_WORDS,
  type ClassificationWord,
  type CorrectionField,
} from "./result-words";
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
    /** The staff screen corrects a final session; the CLI refuses one. */
    onFinal?: OnFinal;
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
      onFinal: input.onFinal,
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

/**
 * Revokes a correction, so the driver goes back to the provider's row, with a
 * reason, and writes the audit row in the same transaction; then the event is
 * checked again, which re-scores the session (M8 Task 7). A final session
 * stays final and counts a reopen (`onFinal: "correct"`). An override that
 * doesn't exist or is already revoked is `not_found`, writing nothing.
 */
export async function revokeOverride(
  db: Db,
  now: Date,
  actor: StaffActor,
  input: { overrideId: string; reason: string },
  deps: StaffDeps = {},
): Promise<{ sessions: SessionMove[] }> {
  const reason = requireReason(input.reason);
  const eventId = await db.transaction(async (tx) => {
    const [row] = await tx
      .select({
        id: resultOverrides.id,
        sessionId: resultOverrides.sessionId,
        driverId: resultOverrides.driverId,
        kind: resultOverrides.kind,
        fields: resultOverrides.fields,
        reason: resultOverrides.reason,
        eventId: sessions.eventId,
      })
      .from(resultOverrides)
      .innerJoin(sessions, eq(sessions.id, resultOverrides.sessionId))
      .where(
        and(
          eq(resultOverrides.id, input.overrideId),
          isNull(resultOverrides.revokedAt),
        ),
      );
    if (!row) {
      throw new StaffError(
        "not_found",
        `no active override ${input.overrideId}`,
      );
    }
    await revokeOverrideRow(tx, now, row.id, SYSTEM_USER_ID, "correct");
    await writeAudit(tx, now, {
      ...audit(actor, reason),
      action: "result_override.revoke",
      entityType: "result_override",
      entityId: row.id,
      before: {
        sessionId: row.sessionId,
        driverId: row.driverId,
        kind: row.kind,
        fields: row.fields,
        reason: row.reason,
      },
      after: null,
    });
    return row.eventId;
  });
  return { sessions: await revalidateEvent(db, now, eventId, deps) };
}

/**
 * Hides a provider row that shouldn't be there (a driver listed who didn't
 * run), with a reason: a `suppress` override, which `effective_results` leaves
 * out, audited as `result_override.create` in the same transaction. Then the
 * event is checked again. A driver with no provider row in the session is
 * `not_found`; a final session is corrected (`onFinal: "correct"`).
 */
export async function suppressResult(
  db: Db,
  now: Date,
  actor: StaffActor,
  input: { sessionId: string; driverId: string; reason: string },
  deps: StaffDeps = {},
): Promise<{ sessions: SessionMove[] }> {
  const reason = requireReason(input.reason);
  const { sessionId, driverId } = input;
  const [session] = await db
    .select({ eventId: sessions.eventId })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  if (!session) throw new StaffError("not_found", `no session ${sessionId}`);

  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ driverId: results.driverId })
      .from(results)
      .where(
        and(eq(results.sessionId, sessionId), eq(results.driverId, driverId)),
      );
    if (!row) {
      throw new StaffError(
        "not_found",
        `driver ${driverId} has no provider row in session ${sessionId}`,
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
    const id = await addOverride(tx, now, {
      sessionId,
      driverId,
      kind: "suppress",
      reason,
      createdBy: SYSTEM_USER_ID,
      onFinal: "correct",
    });
    await writeAudit(tx, now, {
      ...audit(actor, reason),
      action: "result_override.create",
      entityType: "result_override",
      entityId: id,
      before: active
        ? { overrideId: active.id, kind: active.kind, fields: active.fields }
        : null,
      after: { sessionId, driverId, kind: "suppress", fields: {} },
    });
  });
  return { sessions: await revalidateEvent(db, now, session.eventId, deps) };
}

/** A whole number from the form, within `[min, max]`, or `invalid`. */
function wholeNumber(value: string, min: number, max: number): number {
  const n = /^\d+$/.test(value.trim()) ? Number(value.trim()) : Number.NaN;
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new StaffError(
      "invalid",
      `${value} isn't a number from ${min} to ${max}`,
    );
  }
  return n;
}

/** The fields one "Add a correction" sets. */
function correctionFields(
  what: Exclude<CorrectionField, "remove">,
  value: string,
): ResultFields {
  switch (what) {
    case "position":
      return { position: wholeNumber(value, 1, 30) };
    case "grid":
      return { grid: wholeNumber(value, 0, 30) };
    case "fastest_lap":
      return { fastest_lap_rank: wholeNumber(value, 1, 30) };
    case "classification": {
      if (!Object.hasOwn(CLASSIFICATION_WORDS, value)) {
        throw new StaffError("invalid", `no classification ${value}`);
      }
      const classification = value as ClassificationWord;
      return {
        classification,
        provider_status: CLASSIFICATION_WORDS[classification],
      };
    }
  }
}

/**
 * The staff screen's "Add a correction" (M8 Task 7): one change to one
 * driver's row, with the reason players see, audited in the same transaction.
 * It sits on top of the driver's active correction rather than replacing it,
 * so a position fix and a later status fix both stay (one override per
 * driver, DM 2.6, with their fields merged); an inserted row stays an insert.
 * `remove` hides the row (`suppressResult`). A final session is corrected and
 * stays final. Then the event is checked again, which re-scores the session.
 *
 * Refuses a value that doesn't fit (`invalid`) and a driver with no row to
 * correct (`not_found`), writing nothing.
 */
export async function correctResult(
  db: Db,
  now: Date,
  actor: StaffActor,
  input: {
    sessionId: string;
    driverId: string;
    what: CorrectionField;
    value: string;
    reason: string;
  },
  deps: StaffDeps = {},
): Promise<{ sessions: SessionMove[] }> {
  const reason = requireReason(input.reason);
  const { sessionId, driverId, what } = input;
  if (what === "remove") {
    return suppressResult(
      db,
      now,
      actor,
      { sessionId, driverId, reason },
      deps,
    );
  }
  const change = correctionFields(what, input.value);
  const [session] = await db
    .select({ eventId: sessions.eventId })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  if (!session) throw new StaffError("not_found", `no session ${sessionId}`);

  await db.transaction(async (tx) => {
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
    const current =
      active && active.kind !== "suppress"
        ? (active.fields as ResultFields)
        : {};
    const kind = active?.kind === "insert" ? "insert" : "patch";
    if (kind === "patch") {
      const [row] = await tx
        .select({ driverId: results.driverId })
        .from(results)
        .where(
          and(eq(results.sessionId, sessionId), eq(results.driverId, driverId)),
        );
      if (!row) {
        throw new StaffError(
          "not_found",
          `driver ${driverId} has no result in session ${sessionId}`,
        );
      }
    }
    const fields = { ...current, ...change };
    const id = await addOverride(tx, now, {
      sessionId,
      driverId,
      kind,
      fields,
      reason,
      createdBy: SYSTEM_USER_ID,
      onFinal: "correct",
    });
    await writeAudit(tx, now, {
      ...audit(actor, reason),
      action: "result_override.create",
      entityType: "result_override",
      entityId: id,
      before: active
        ? { overrideId: active.id, kind: active.kind, fields: active.fields }
        : null,
      after: { sessionId, driverId, kind, fields },
    });
  });
  return { sessions: await revalidateEvent(db, now, session.eventId, deps) };
}
