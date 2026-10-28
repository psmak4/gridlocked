import { and, eq, like, sql } from "drizzle-orm";
import { RESULT_STATES, reviewItems, sessionResultState } from "@/db/schema";
import type { Db } from "@/db/types";
import { AUTO_RESOLUTION, canonical, openReviewItem } from "@/reference/review";
import { getSessionContext } from "./session-context";
import {
  problemSubject,
  SCORED_KINDS,
  validateSession,
  type Problem,
} from "./validate";

export type SessionResultStatus = (typeof RESULT_STATES)[number];

/** Review kinds with their own name (DM 2.9); the rest are `validation_failed`. */
const OWN_KIND = new Set([
  "unknown_driver",
  "unknown_constructor",
  "team_change",
  "missing_driver",
]);

/**
 * Brings the session's validation review items in line with `problems`:
 * - a blocking problem with no open item opens one, unless an admin already
 *   decided this very finding (a resolved or dismissed item with the same key
 *   and the same details), which is not asked again;
 * - an open item for a problem that is still there gets its details refreshed;
 * - an open item for a problem that is gone is resolved automatically, so a
 *   fixed session can advance. An auto-resolved finding that comes back is a
 *   new finding, and opens a new item.
 */
async function reconcileValidationItems(
  tx: Db,
  now: Date,
  sessionId: string,
  ctx: { seasonId: string; eventId: string },
  problems: Problem[],
) {
  const existing = await tx
    .select()
    .from(reviewItems)
    .where(
      and(
        eq(reviewItems.sessionId, sessionId),
        like(reviewItems.dedupeKey, `validate:${sessionId}:%`),
      ),
    );

  const current = new Set<string>();
  for (const problem of problems) {
    if (problem.severity !== "blocking") continue;
    const dedupeKey = `validate:${sessionId}:${problem.kind}:${problemSubject(problem)}`;
    current.add(dedupeKey);
    const details = { problem: problem.kind, ...problem.details };
    const same = existing.filter((i) => i.dedupeKey === dedupeKey);

    const open = same.find((i) => i.status === "open");
    if (open) {
      if (canonical(open.details) !== canonical(details)) {
        await tx
          .update(reviewItems)
          .set({ details, version: sql`${reviewItems.version} + 1` })
          // Only while open: an admin may have resolved it since we read it.
          .where(
            and(eq(reviewItems.id, open.id), eq(reviewItems.status, "open")),
          );
      }
      continue;
    }
    const decided = same.some(
      (i) =>
        !i.resolution?.startsWith("auto:") &&
        canonical(i.details) === canonical(details),
    );
    if (decided) continue;

    await openReviewItem(tx, now, {
      kind: OWN_KIND.has(problem.kind) ? problem.kind : "validation_failed",
      severity: "blocking",
      seasonId: ctx.seasonId,
      eventId: ctx.eventId,
      sessionId,
      driverId:
        typeof problem.details.driverId === "string"
          ? problem.details.driverId
          : null,
      details,
      dedupeKey,
    });
  }

  for (const item of existing) {
    if (item.status === "open" && !current.has(item.dedupeKey)) {
      await tx
        .update(reviewItems)
        .set({
          status: "resolved",
          resolution: AUTO_RESOLUTION,
          resolvedAt: now,
          version: sql`${reviewItems.version} + 1`,
        })
        .where(
          and(eq(reviewItems.id, item.id), eq(reviewItems.status, "open")),
        );
    }
  }
}

/**
 * Validates a scored session and moves its status (DM 2.3, 2.9), in one
 * transaction that first locks the session's state row (the database guard
 * is only a check, not a lock):
 * - an open blocking review item, from the validator or from anywhere else,
 *   puts the session `under_review`;
 * - otherwise a session that is not yet complete is `awaiting`;
 * - otherwise it is `provisional`.
 * A `final` session is never touched here. Returns the resulting status.
 *
 * Callers (the poll and finalize jobs, and the override actions) must call it
 * after every normalization and after every override change (`addOverride`,
 * `revokeOverride`): neither moves the status itself, so a session whose
 * effective results changed keeps its old status until this runs.
 *
 * A session that is `provisional` or `under_review` and loses rows is not
 * sent back to `awaiting`: each missing driver opens a blocking
 * `missing_driver` item and the session is `under_review`.
 *
 * Provider data after a manual entry (DM 2.6): when the session's source is
 * `manual` and a provider snapshot has been normalized, a blocking
 * `provider_after_manual` item opens, once per snapshot. The manual rows are
 * not touched: the admin decides to keep or revoke them.
 */
export async function advanceStatus(
  db: Db,
  now: Date,
  sessionId: string,
): Promise<SessionResultStatus> {
  const ctx = await getSessionContext(db, sessionId);
  if (!SCORED_KINDS.includes(ctx.kind)) {
    throw new Error(`a ${ctx.kind} session has no results to validate`);
  }

  return db.transaction(async (tx) => {
    await tx
      .insert(sessionResultState)
      .values({ sessionId })
      .onConflictDoNothing();
    const [state] = await tx
      .select()
      .from(sessionResultState)
      .where(eq(sessionResultState.sessionId, sessionId))
      .for("update");
    if (state!.status === "final") return "final";

    const validated = await validateSession(tx, sessionId);
    // Only a session that has not had its results yet may be merely
    // incomplete. One that was provisional or under review and has lost rows
    // (a suppress, a revoked manual insert) is a surprise: each missing driver
    // is a blocking finding, never a silent drop back to awaiting.
    const incomplete = validated.find((p) => p.kind === "incomplete");
    const problems =
      incomplete && state!.status !== "awaiting"
        ? [
            ...validated,
            ...(incomplete.details.missingDriverIds as string[]).map(
              (driverId): Problem => ({
                kind: "missing_driver",
                severity: "blocking",
                details: { driverId, afterResults: true },
              }),
            ),
          ]
        : validated;
    await reconcileValidationItems(tx, now, sessionId, ctx, problems);

    if (state!.source === "manual" && state!.currentSnapshotId !== null) {
      const dedupeKey = `provider_after_manual:${sessionId}:${state!.currentSnapshotId}`;
      // Any status: once an admin has decided about this snapshot, it stays decided.
      const [asked] = await tx
        .select({ id: reviewItems.id })
        .from(reviewItems)
        .where(eq(reviewItems.dedupeKey, dedupeKey));
      if (!asked) {
        await openReviewItem(tx, now, {
          kind: "provider_after_manual",
          severity: "blocking",
          seasonId: ctx.seasonId,
          eventId: ctx.eventId,
          sessionId,
          details: { snapshotId: state!.currentSnapshotId },
          dedupeKey,
        });
      }
    }

    const [blocking] = await tx
      .select({ id: reviewItems.id })
      .from(reviewItems)
      .where(
        and(
          eq(reviewItems.sessionId, sessionId),
          eq(reviewItems.status, "open"),
          eq(reviewItems.severity, "blocking"),
        ),
      )
      .limit(1);
    const next: SessionResultStatus = blocking
      ? "under_review"
      : incomplete
        ? "awaiting"
        : "provisional";

    if (next !== state!.status) {
      await tx
        .update(sessionResultState)
        .set({ status: next, version: state!.version + 1 })
        .where(eq(sessionResultState.sessionId, sessionId));
    }
    return next;
  });
}
