import { and, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import { z } from "zod";
import {
  circuits,
  drivers,
  events,
  providerIds,
  seatAssignments,
  sessionParticipants,
  sessions,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { openReviewItem } from "@/reference/review";
import { localDate } from "@/reference/sync-event-entries";

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
  constructorId: string;
  code: string | null;
}

/**
 * Replaces the session's participants with OpenF1's rows, in one transaction
 * (provider `openf1`, from the stored snapshot).
 *
 * A row is matched to a driver by car number through the seats active on the
 * session's date (race or reserve), unless the seat's driver code disagrees
 * with the acronym; then by `name_acronym` = `drivers.code`. Its constructor is
 * the seat's. The team name is learned the first time a seat-matched driver
 * shows it (`provider_ids`, entity type `constructor`); once known, it decides
 * the constructor, so a car that OpenF1 shows in another team's colors reaches
 * the roster check as a team change. A row that cannot be matched, or has no
 * constructor, opens an `unknown_driver` warning (practice is not scored) and
 * is left out.
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
          constructorId: seatAssignments.constructorId,
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
    const seatByDriver = new Map<string, Seat>();
    for (const seat of active) {
      seatsByNumber.set(seat.carNumber, [
        ...(seatsByNumber.get(seat.carNumber) ?? []),
        seat,
      ]);
      if (!seatByDriver.has(seat.driverId)) {
        seatByDriver.set(seat.driverId, seat);
      }
    }

    const acronyms = [...new Set(rows.map((r) => r.acronym).filter(Boolean))];
    const byCode = new Map<string, string[]>();
    if (acronyms.length > 0) {
      const found = await tx
        .select({ id: drivers.id, code: drivers.code })
        .from(drivers)
        .where(inArray(drivers.code, acronyms));
      for (const d of found) {
        byCode.set(d.code!, [...(byCode.get(d.code!) ?? []), d.id]);
      }
    }
    // A code is reused across eras: of several drivers, the ones with a seat
    // this season.
    const seasonDrivers = new Set(
      (
        await tx
          .select({ id: seatAssignments.driverId })
          .from(seatAssignments)
          .where(eq(seatAssignments.seasonId, ctx.seasonId))
      ).map((r) => r.id),
    );

    const teamIds = new Map(
      (
        await tx
          .select({
            name: providerIds.providerKey,
            id: providerIds.entityId,
          })
          .from(providerIds)
          .where(
            and(
              eq(providerIds.provider, PROVIDER),
              eq(providerIds.entityType, "constructor"),
            ),
          )
      ).map((r) => [r.name, r.id]),
    );

    // Who each row is. By number first, then by acronym.
    const matched = rows.map((row) => {
      const bySeat = (seatsByNumber.get(row.driverNumber) ?? []).find(
        (s) => !s.code || !row.acronym || s.code === row.acronym,
      );
      if (bySeat) return { row, driverId: bySeat.driverId, seat: bySeat };
      const candidates = byCode.get(row.acronym) ?? [];
      const known = candidates.filter((id) => seasonDrivers.has(id));
      const picked =
        candidates.length === 1
          ? candidates[0]
          : known.length === 1
            ? known[0]
            : undefined;
      return {
        row,
        driverId: picked,
        seat: picked ? seatByDriver.get(picked) : undefined,
      };
    });

    // Learn team names from the seat-matched drivers first, so a driver with
    // no seat can use them.
    for (const { row, seat } of matched) {
      if (!seat || !row.teamName || teamIds.has(row.teamName)) continue;
      const inserted = await tx
        .insert(providerIds)
        .values({
          provider: PROVIDER,
          entityType: "constructor",
          providerKey: row.teamName,
          entityId: seat.constructorId,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning({ key: providerIds.providerKey });
      if (inserted.length > 0) teamIds.set(row.teamName, seat.constructorId);
    }

    const stored = new Map<
      string,
      { driverId: string; constructorId: string }
    >();
    for (const { row, driverId, seat } of matched) {
      const constructorId =
        teamIds.get(row.teamName) ?? seat?.constructorId ?? undefined;
      if (!driverId || !constructorId) {
        await openReviewItem(tx, now, {
          kind: "unknown_driver",
          seasonId: ctx.seasonId,
          eventId: ctx.eventId,
          sessionId,
          details: {
            provider: PROVIDER,
            driverNumber: row.driverNumber,
            acronym: row.acronym,
            teamName: row.teamName,
            reason: driverId ? "no_constructor" : "no_driver",
            snapshotId,
          },
          dedupeKey: `openf1_unknown:${sessionId}:${row.driverNumber}`,
        });
        continue;
      }
      if (!stored.has(driverId)) {
        stored.set(driverId, { driverId, constructorId });
      }
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
