import { and, desc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import { z } from "zod";
import {
  circuits,
  drivers,
  eventEntries,
  events,
  providerIds,
  rawSnapshots,
  reviewItems,
  seatAssignments,
  sessionParticipants,
  sessions,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { openReviewItem } from "@/reference/review";
import { localDate } from "@/reference/sync-event-entries";
import { OPENF1_TEAMS } from "./teams";

// OpenF1's practice participants (HLD §8.2): who took part in a practice
// session, and for which team. OpenF1 has no stable driver id, so a row is
// matched to ours by car number through the season's seats, then by acronym.
// Nothing outside src/providers sees these key names.

const PROVIDER = "openf1";

/** One row of OpenF1's `drivers?session_key=<k>`, the parts we use. */
export interface OpenF1Driver {
  driverNumber: number;
  teamName: string;
  acronym: string;
}

const text = z
  .string()
  .nullish()
  .transform((value) => value ?? "");

const driversSchema = z.array(
  z.object({
    driver_number: z.number().int(),
    team_name: text,
    name_acronym: text,
  }),
);

/** Reads OpenF1's `drivers` response. Throws on a shape we do not know. */
export function parseOpenF1Drivers(body: unknown): OpenF1Driver[] {
  return driversSchema.parse(body).map((row) => ({
    driverNumber: row.driver_number,
    teamName: row.team_name,
    acronym: row.name_acronym,
  }));
}

/** One row of OpenF1's `sessions?year=<y>`, the parts we use. */
export interface OpenF1Session {
  sessionKey: number;
  sessionName: string;
  dateStart: string;
}

const sessionsSchema = z.array(
  z.object({
    session_key: z.number().int(),
    session_name: z.string(),
    date_start: z.string(),
  }),
);

/** Reads OpenF1's `sessions` response. Throws on a shape we do not know. */
export function parseOpenF1Sessions(body: unknown): OpenF1Session[] {
  return sessionsSchema.parse(body).map((row) => ({
    sessionKey: row.session_key,
    sessionName: row.session_name,
    dateStart: row.date_start,
  }));
}

const PRACTICE_KINDS: Record<string, "fp1" | "fp2" | "fp3"> = {
  "Practice 1": "fp1",
  "Practice 2": "fp2",
  "Practice 3": "fp3",
};
/** An OpenF1 start this close to ours is the same session. */
const SAME_SESSION_MS = 24 * 3_600_000;

/**
 * Links OpenF1's practice sessions to ours (same kind, start within a day) with
 * `provider_ids` rows (`entity_type = 'session'`, key = session key), so later
 * polls reuse them. Returns how many links this call added.
 */
export async function linkOpenF1Sessions(
  db: Db,
  now: Date,
  body: unknown,
): Promise<{ linked: number }> {
  const theirs = parseOpenF1Sessions(body).filter(
    (s) => PRACTICE_KINDS[s.sessionName] !== undefined,
  );
  const ours = await db
    .select({
      id: sessions.id,
      kind: sessions.kind,
      start: sessions.scheduledStart,
    })
    .from(sessions)
    .where(inArray(sessions.kind, ["fp1", "fp2", "fp3"]));

  let linked = 0;
  await db.transaction(async (tx) => {
    for (const s of theirs) {
      const start = Date.parse(s.dateStart);
      if (Number.isNaN(start)) continue;
      const kind = PRACTICE_KINDS[s.sessionName];
      const match = ours
        .filter((o) => o.kind === kind)
        .map((o) => ({ o, gap: Math.abs(o.start.getTime() - start) }))
        .filter(({ gap }) => gap <= SAME_SESSION_MS)
        .sort((a, b) => a.gap - b.gap)[0];
      if (!match) continue;
      const inserted = await tx
        .insert(providerIds)
        .values({
          provider: PROVIDER,
          entityType: "session",
          providerKey: String(s.sessionKey),
          entityId: match.o.id,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning({ key: providerIds.providerKey });
      linked += inserted.length;
    }
  });
  return { linked };
}

/** The OpenF1 session key linked to one of our sessions, or null. */
export async function openF1SessionKey(
  db: Db,
  sessionId: string,
): Promise<number | null> {
  const [row] = await db
    .select({ key: providerIds.providerKey })
    .from(providerIds)
    .where(
      and(
        eq(providerIds.provider, PROVIDER),
        eq(providerIds.entityType, "session"),
        eq(providerIds.entityId, sessionId),
      ),
    );
  return row ? Number(row.key) : null;
}

interface Seat {
  driverId: string;
  code: string | null;
}

/**
 * Replaces the session's participants with OpenF1's rows, in one transaction
 * (provider `openf1`, from the stored snapshot).
 *
 * The entries and seats only identify the driver: a row is matched by car
 * number through the event's entries first (so a substitute staff entered for
 * the event is known even with no seat or code), then through the seats
 * active on the session's date (race or reserve), unless the driver's code
 * disagrees with the acronym; then by `name_acronym` =
 * `drivers.code`, which maps only a driver with a seat this season. The
 * constructor comes from OpenF1's `team_name` through the static `OPENF1_TEAMS`
 * map, so a car shown in another team's colors reaches the roster check as a
 * team change. A row with no driver, or with a team we have no mapping for
 * (reason `unknown_team`), opens an `unknown_driver` warning (practice is not
 * scored) and is left out.
 *
 * No rows at all means OpenF1 has nothing for the session yet, so what is
 * stored stays.
 */
export async function storeParticipants(
  db: Db,
  now: Date,
  sessionId: string,
  snapshotId: string,
  rows: OpenF1Driver[],
): Promise<void> {
  if (rows.length === 0) return;

  await db.transaction(async (tx) => {
    const [ctx] = await tx
      .select({
        eventId: events.id,
        seasonId: events.seasonId,
        start: sessions.scheduledStart,
        timezone: circuits.timezone,
      })
      .from(sessions)
      .innerJoin(events, eq(events.id, sessions.eventId))
      .innerJoin(circuits, eq(circuits.id, events.circuitId))
      .where(eq(sessions.id, sessionId));
    if (!ctx) throw new Error(`storeParticipants: no session ${sessionId}`);
    const day = localDate(ctx.start, ctx.timezone);

    // Seats active on the session date; a race seat wins over a reserve one.
    const active = (
      await tx
        .select({
          driverId: seatAssignments.driverId,
          carNumber: seatAssignments.carNumber,
          role: seatAssignments.role,
          code: drivers.code,
        })
        .from(seatAssignments)
        .innerJoin(drivers, eq(drivers.id, seatAssignments.driverId))
        .where(
          and(
            eq(seatAssignments.seasonId, ctx.seasonId),
            lte(seatAssignments.validFrom, day),
            or(
              isNull(seatAssignments.validTo),
              gte(seatAssignments.validTo, day),
            ),
          ),
        )
    ).sort((a, b) => Number(b.role === "race") - Number(a.role === "race"));
    const seatsByNumber = new Map<number, Seat[]>();
    for (const seat of active) {
      seatsByNumber.set(seat.carNumber, [
        ...(seatsByNumber.get(seat.carNumber) ?? []),
        seat,
      ]);
    }

    // The event's entries, by car number: a staff-entered substitute first.
    const entriesByNumber = new Map<number, Seat[]>();
    for (const entry of await tx
      .select({
        driverId: eventEntries.driverId,
        carNumber: eventEntries.carNumber,
        code: drivers.code,
      })
      .from(eventEntries)
      .innerJoin(drivers, eq(drivers.id, eventEntries.driverId))
      .where(eq(eventEntries.eventId, ctx.eventId))) {
      entriesByNumber.set(entry.carNumber, [
        ...(entriesByNumber.get(entry.carNumber) ?? []),
        entry,
      ]);
    }

    // The acronym fallback only picks among drivers with a seat this season.
    const seasonDrivers = new Set(
      (
        await tx
          .select({ id: seatAssignments.driverId })
          .from(seatAssignments)
          .where(eq(seatAssignments.seasonId, ctx.seasonId))
      ).map((r) => r.id),
    );
    const acronyms = [...new Set(rows.map((r) => r.acronym).filter(Boolean))];
    const byCode = new Map<string, string[]>();
    if (acronyms.length > 0) {
      const found = await tx
        .select({ id: drivers.id, code: drivers.code })
        .from(drivers)
        .where(inArray(drivers.code, acronyms));
      for (const d of found) {
        if (!seasonDrivers.has(d.id)) continue;
        byCode.set(d.code!, [...(byCode.get(d.code!) ?? []), d.id]);
      }
    }

    // Our constructor ids for the Jolpica keys of the static team map.
    const constructorIds = new Map(
      (
        await tx
          .select({ key: providerIds.providerKey, id: providerIds.entityId })
          .from(providerIds)
          .where(
            and(
              eq(providerIds.provider, "jolpica"),
              eq(providerIds.entityType, "constructor"),
              inArray(providerIds.providerKey, Object.values(OPENF1_TEAMS)),
            ),
          )
      ).map((r) => [r.key, r.id]),
    );

    const stored = new Map<
      string,
      { driverId: string; constructorId: string }
    >();
    const unknown = (
      row: OpenF1Driver,
      reason: "no_driver" | "unknown_team",
      dedupeKey: string,
    ) =>
      openReviewItem(tx, now, {
        kind: "unknown_driver",
        seasonId: ctx.seasonId,
        eventId: ctx.eventId,
        sessionId,
        details: {
          provider: PROVIDER,
          driverNumber: row.driverNumber,
          acronym: row.acronym,
          teamName: row.teamName,
          reason,
          snapshotId,
        },
        dedupeKey,
      });

    for (const row of rows) {
      // By car number, entries before seats. A driver whose code is the
      // acronym wins over one with no code to compare, so an entered driver
      // with no code cannot take over a known driver's number.
      const byNumber = [
        ...(entriesByNumber.get(row.driverNumber) ?? []),
        ...(seatsByNumber.get(row.driverNumber) ?? []),
      ];
      const numbered =
        byNumber.find((s) => row.acronym && s.code === row.acronym) ??
        byNumber.find((s) => !s.code || !row.acronym);
      const candidates = byCode.get(row.acronym) ?? [];
      const driverId =
        numbered?.driverId ??
        (candidates.length === 1 ? candidates[0] : undefined);
      if (!driverId) {
        await unknown(
          row,
          "no_driver",
          `openf1_unknown:${sessionId}:${row.driverNumber}`,
        );
        continue;
      }
      const key = OPENF1_TEAMS[row.teamName];
      const constructorId = key ? constructorIds.get(key) : undefined;
      if (!constructorId) {
        await unknown(
          row,
          "unknown_team",
          `openf1_unknown_team:${sessionId}:${row.teamName}`,
        );
        continue;
      }
      if (!stored.has(driverId)) {
        stored.set(driverId, { driverId, constructorId });
      }
      // A car we could not place before (no entry yet) is known now.
      await tx
        .update(reviewItems)
        .set({
          status: "resolved",
          resolution: "auto: no longer detected",
          resolvedAt: now,
        })
        .where(
          and(
            eq(
              reviewItems.dedupeKey,
              `openf1_unknown:${sessionId}:${row.driverNumber}`,
            ),
            eq(reviewItems.status, "open"),
          ),
        );
    }

    await tx
      .delete(sessionParticipants)
      .where(eq(sessionParticipants.sessionId, sessionId));
    if (stored.size > 0) {
      await tx.insert(sessionParticipants).values(
        [...stored.values()].map((p) => ({
          sessionId,
          driverId: p.driverId,
          constructorId: p.constructorId,
          provider: PROVIDER,
          snapshotId,
        })),
      );
    }
  });
}

/**
 * Stores the session's participants again from its latest stored OpenF1
 * `drivers` answer, with no fetch. Staff call it after entering a substitute,
 * so a car left out because nobody was entered for it is matched now and the
 * roster check sees the real line-up. Does nothing if nothing is stored.
 */
export async function rematchParticipants(
  db: Db,
  now: Date,
  sessionId: string,
): Promise<void> {
  const [latest] = await db
    .select({ id: rawSnapshots.id, body: rawSnapshots.body })
    .from(rawSnapshots)
    .where(
      and(
        eq(rawSnapshots.provider, PROVIDER),
        eq(rawSnapshots.endpoint, "/drivers"),
        eq(rawSnapshots.sessionId, sessionId),
      ),
    )
    .orderBy(desc(rawSnapshots.lastSeenAt))
    .limit(1);
  if (!latest) return;
  await storeParticipants(
    db,
    now,
    sessionId,
    latest.id,
    parseOpenF1Drivers(latest.body),
  );
}
