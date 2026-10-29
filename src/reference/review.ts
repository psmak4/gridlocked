import { and, eq, like, sql } from "drizzle-orm";
import { reviewItems } from "@/db/schema";
import type { Db } from "@/db/types";
import { newId } from "@/lib/ids";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

/**
 * What `openReviewItem` needs: any Drizzle Postgres database or transaction.
 * The job queue is generic over the schema (`JobsDb`), so it takes this wider
 * type, and `Db` is assignable to it.
 */
type AnyPgDb = PgDatabase<PgQueryResultHKT, Record<string, unknown>>;

/**
 * Opens an item in the admin queue: a warning, unless `severity` says
 * `blocking`, which holds scoring for the session (DM 2.9). A second call with the same
 * `dedupeKey` while the first is still open does nothing. Returns true when
 * this call opened a new item.
 */
export async function openReviewItem(
  db: AnyPgDb,
  now: Date,
  item: {
    kind: string;
    severity?: "warning" | "blocking";
    /** Null for an item that belongs to no season (a dead job). */
    seasonId: string | null;
    eventId?: string | null;
    sessionId?: string | null;
    driverId?: string | null;
    details: Record<string, unknown>;
    dedupeKey: string;
  },
): Promise<boolean> {
  const rows = await db
    .insert(reviewItems)
    .values({
      id: newId(),
      kind: item.kind,
      severity: item.severity ?? "warning",
      seasonId: item.seasonId,
      eventId: item.eventId ?? null,
      sessionId: item.sessionId ?? null,
      driverId: item.driverId ?? null,
      details: item.details,
      dedupeKey: item.dedupeKey,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: reviewItems.id });
  return rows.length > 0;
}

/** JSON with sorted keys, so two details objects compare by content. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export const AUTO_RESOLUTION = "auto: no longer detected";

export interface Finding {
  kind: string;
  seasonId: string;
  eventId: string;
  sessionId?: string | null;
  driverId?: string | null;
  details: Record<string, unknown>;
  dedupeKey: string;
}

/**
 * Brings the warnings under `keyPrefix` in line with what a check found now
 * (the approach `advanceStatus` uses for its blocking items):
 * - a finding with no open item opens one, unless an admin already decided
 *   this very finding (a resolved or dismissed item with the same key and the
 *   same details), which is not asked again;
 * - an open item for a finding that is still there gets its details refreshed;
 * - an open item for a finding that is gone is resolved automatically. An
 *   auto-resolved finding that comes back is a new finding.
 */
export async function reconcileWarnings(
  db: Db,
  now: Date,
  keyPrefix: string,
  findings: Finding[],
): Promise<void> {
  const existing = await db
    .select()
    .from(reviewItems)
    .where(like(reviewItems.dedupeKey, `${keyPrefix}%`));

  const current = new Set<string>();
  for (const finding of findings) {
    current.add(finding.dedupeKey);
    const same = existing.filter((i) => i.dedupeKey === finding.dedupeKey);
    const open = same.find((i) => i.status === "open");
    if (open) {
      if (canonical(open.details) !== canonical(finding.details)) {
        await db
          .update(reviewItems)
          .set({
            details: finding.details,
            version: sql`${reviewItems.version} + 1`,
          })
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
        canonical(i.details) === canonical(finding.details),
    );
    if (decided) continue;
    await openReviewItem(db, now, finding);
  }

  for (const item of existing) {
    if (item.status === "open" && !current.has(item.dedupeKey)) {
      await db
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
