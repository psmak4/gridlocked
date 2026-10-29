import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { providerIds, sessions } from "@/db/schema";
import type { Db } from "@/db/types";
import { openReviewItem } from "@/reference/review";
import { normalizeSession } from "@/results/normalize";
import { getSessionContext } from "@/results/session-context";
import type { ResultRow } from "@/results/types";
import {
  parseJolpicaResults,
  type ExpectedRace,
  type JolpicaResultRow,
} from "./results";
import { jolpicaEventKey } from "./event-key";

const PROVIDER = "jolpica";

type EntityType = "driver" | "constructor";

async function idsFor(
  db: Db,
  entityType: EntityType,
  keys: string[],
): Promise<Map<string, string>> {
  if (keys.length === 0) return new Map();
  const rows = await db
    .select({ key: providerIds.providerKey, id: providerIds.entityId })
    .from(providerIds)
    .where(
      and(
        eq(providerIds.provider, PROVIDER),
        eq(providerIds.entityType, entityType),
        inArray(providerIds.providerKey, keys),
      ),
    );
  return new Map(rows.map((r) => [r.key, r.id]));
}

/**
 * Replaces Jolpica's driver and constructor keys with our ids, through
 * `provider_ids`. If any key has no mapping, nothing is mapped: the caller
 * gets the unmapped keys instead.
 */
export async function mapJolpicaKeys(
  db: Db,
  rows: JolpicaResultRow[],
): Promise<
  | { rows: ResultRow[] }
  | { unmapped: Array<{ entityType: EntityType; key: string }> }
> {
  const driverKeys = [...new Set(rows.map((r) => r.driverKey))];
  const constructorKeys = [...new Set(rows.map((r) => r.constructorKey))];
  const driverIds = await idsFor(db, "driver", driverKeys);
  const constructorIds = await idsFor(db, "constructor", constructorKeys);

  const unmapped = [
    ...driverKeys
      .filter((key) => !driverIds.has(key))
      .map((key) => ({ entityType: "driver" as const, key })),
    ...constructorKeys
      .filter((key) => !constructorIds.has(key))
      .map((key) => ({ entityType: "constructor" as const, key })),
  ];
  if (unmapped.length > 0) return { unmapped };

  return {
    rows: rows.map(({ driverKey, constructorKey, ...facts }) => ({
      ...facts,
      driverId: driverIds.get(driverKey)!,
      constructorId: constructorIds.get(constructorKey)!,
    })),
  };
}

/**
 * What we asked Jolpica for the event: the season and round of its key, and
 * the date of its race (UTC). Null when the event has no Jolpica key, which
 * means nothing was asked of Jolpica, so there is nothing to check.
 */
async function expectedRace(
  db: Db,
  eventId: string,
): Promise<ExpectedRace | null> {
  const key = await jolpicaEventKey(db, eventId);
  const m = key === null ? null : /^(\d+)\/(\d+)$/.exec(key);
  if (!m) return null;
  const [race] = await db
    .select({ start: sessions.scheduledStart })
    .from(sessions)
    .where(
      and(
        eq(sessions.eventId, eventId),
        eq(sessions.kind, "race"),
        ne(sessions.status, "cancelled"),
      ),
    )
    .orderBy(asc(sessions.scheduledStart))
    .limit(1);
  return {
    season: Number(m[1]),
    round: Number(m[2]),
    date: race ? race.start.toISOString().slice(0, 10) : null,
  };
}

/**
 * The job's entry point: parses a Jolpica response for the session, maps its
 * driver and constructor keys to our ids and normalizes it.
 *
 * A body for another season, round or date than the event's (see
 * `parseJolpicaResults`) holds the session as a `validation_failed` item with
 * `asked` and `got` in its details; nothing is written.
 *
 * A key with no `provider_ids` row holds the whole session: nothing is
 * written, and each such key opens one blocking `unknown_driver` or
 * `unknown_constructor` review item (deduped per session and key).
 */
export async function normalizeJolpicaSession(
  db: Db,
  now: Date,
  sessionId: string,
  snapshotId: string,
  body: unknown,
): Promise<{ changed: number }> {
  const ctx = await getSessionContext(db, sessionId);
  const expected = await expectedRace(db, ctx.eventId);
  const parsed = parseJolpicaResults(ctx.kind, body, expected ?? undefined);
  if (!parsed.ok) {
    return normalizeSession(db, now, sessionId, snapshotId, parsed);
  }
  const mapped = await mapJolpicaKeys(db, parsed.rows);
  if ("unmapped" in mapped) {
    await db.transaction(async (tx) => {
      for (const { entityType, key } of mapped.unmapped) {
        await openReviewItem(tx, now, {
          kind: `unknown_${entityType}`,
          severity: "blocking",
          seasonId: ctx.seasonId,
          eventId: ctx.eventId,
          sessionId,
          details: { provider: PROVIDER, entityType, key, snapshotId },
          dedupeKey: `unmapped:${sessionId}:${PROVIDER}:${entityType}:${key}`,
        });
      }
    });
    return { changed: 0 };
  }
  return normalizeSession(db, now, sessionId, snapshotId, {
    ok: true,
    rows: mapped.rows,
  });
}
