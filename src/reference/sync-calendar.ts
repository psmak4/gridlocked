import { and, eq, inArray, sql } from "drizzle-orm";
import { circuits, events, providerIds, sessions } from "@/db/schema";
import type { Db } from "@/db/types";
import type { Clock } from "@/lib/clock";
import { newId } from "@/lib/ids";
import { getSetting } from "@/settings";
import type {
  CalendarCircuit,
  CalendarEvent,
  CalendarSession,
  CalendarSource,
  SessionKind,
  SyncReport,
} from "./calendar-types";
import { openReviewItem } from "./review";
import { ensureSeason } from "./season";
import { kebab, normalizeEventName, uniqueSlug } from "./slugs";
import { syncEventEntries } from "./sync-event-entries";

// The calendar sync (DM 1.3, 1.4, 1.11). It takes our own CalendarEvent[]; an
// adapter parses the provider's response into that and passes it in.
//
// Events are never upserted on (season_id, round): that unique is DEFERRABLE,
// and Postgres cannot use a deferrable unique as an ON CONFLICT arbiter. They
// are matched here instead, and `round` is updated in a transaction with the
// constraint deferred, so a whole calendar can be renumbered.
//
// Nothing is ever deleted from events or sessions. The whole sync is one
// transaction: a failure leaves no half-synced calendar.

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** The race-date window for recognising the same event (DM 1.3). */
const MATCH_DAYS = 3;
/** Placeholder zone for a circuit nobody has given one yet. */
const PLACEHOLDER_TIMEZONE = "UTC";

type MatchDecision =
  | { type: "match"; existing: ExistingEvent }
  | { type: "new" }
  | { type: "uncertain"; reason: UncertainReason; candidates: ExistingEvent[] };

type UncertainReason = "ambiguous" | "no_strict_match" | "circuit_changed";

interface ExistingEvent {
  row: typeof events.$inferSelect;
  /** The provider's current key for it, if it has one. */
  key: string | null;
  /** UTC date of its race, `YYYY-MM-DD`. */
  raceDate: string;
  normalizedName: string;
}

function utcDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function daysApart(a: string, b: string): number {
  return (
    Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) /
    DAY_MS
  );
}

function sessionKey(kind: string, sequence: number): string {
  return `${kind}:${sequence}`;
}

/** Sessions of an incoming event, each with its sequence among its kind. */
function numbered(list: CalendarSession[]) {
  const seen = new Map<SessionKind, number>();
  return list.map((s) => {
    const sequence = (seen.get(s.kind) ?? 0) + 1;
    seen.set(s.kind, sequence);
    return { ...s, sequence };
  });
}

/** Which session's start locks the game (DM 1.3). */
function lockKind(event: CalendarEvent): SessionKind | null {
  const kinds = new Set(event.sessions.map((s) => s.kind));
  if (event.format === "sprint" && kinds.has("sprint_qualifying")) {
    return "sprint_qualifying";
  }
  return kinds.has("qualifying") ? "qualifying" : null;
}

export async function syncCalendar(
  db: Db,
  clock: Clock,
  season: number,
  source: CalendarSource,
): Promise<SyncReport> {
  const provider = source.provider ?? "jolpica";
  const now = clock.now();
  const incoming = [...source.events].sort((a, b) => a.round - b.round);

  const keys = new Set<string>();
  for (const event of incoming) {
    if (keys.has(event.key)) {
      throw new Error(`syncCalendar: duplicate event key ${event.key}`);
    }
    keys.add(event.key);
    if (event.sessions.length === 0) {
      throw new Error(`syncCalendar: event ${event.key} has no sessions`);
    }
  }

  return db.transaction(async (tx) => {
    // `round` is unique per season, deferrable: checked at commit.
    await tx.execute(sql`SET CONSTRAINTS ALL DEFERRED`);
    const durations = await getSetting(tx, "session_durations");

    // --- The season ------------------------------------------------------
    const seasonRow = await ensureSeason(tx, season, now);
    const seasonId = seasonRow.id;

    // --- What we already have --------------------------------------------
    const eventRows = await tx
      .select()
      .from(events)
      .where(eq(events.seasonId, seasonId));
    const eventIds = eventRows.map((e) => e.id);
    const existingSessions = eventIds.length
      ? await tx
          .select()
          .from(sessions)
          .where(inArray(sessions.eventId, eventIds))
      : [];
    const eventKeyRows = await tx
      .select()
      .from(providerIds)
      .where(
        and(
          eq(providerIds.provider, provider),
          eq(providerIds.entityType, "event"),
        ),
      );
    const keyByEvent = new Map(
      eventKeyRows.map((r) => [r.entityId, r.providerKey]),
    );
    const eventByKey = new Map(
      eventKeyRows.map((r) => [r.providerKey, r.entityId]),
    );
    const circuitKeyRows = await tx
      .select()
      .from(providerIds)
      .where(
        and(
          eq(providerIds.provider, provider),
          eq(providerIds.entityType, "circuit"),
        ),
      );
    const circuitByKey = new Map(
      circuitKeyRows.map((r) => [r.providerKey, r.entityId]),
    );
    const circuitKeyById = new Map(
      circuitKeyRows.map((r) => [r.entityId, r.providerKey]),
    );

    const sessionsByEvent = new Map<
      string,
      Array<typeof sessions.$inferSelect>
    >();
    for (const s of existingSessions) {
      const list = sessionsByEvent.get(s.eventId) ?? [];
      list.push(s);
      sessionsByEvent.set(s.eventId, list);
    }

    const existing: ExistingEvent[] = eventRows.map((row) => {
      const own = sessionsByEvent.get(row.id) ?? [];
      const raceSession =
        own.find((s) => s.kind === "race" && s.sequence === 1) ??
        [...own].sort(
          (a, b) => b.scheduledStart.getTime() - a.scheduledStart.getTime(),
        )[0];
      return {
        row,
        key: keyByEvent.get(row.id) ?? null,
        raceDate: utcDate(raceSession?.scheduledStart ?? row.lockAt),
        normalizedName: normalizeEventName(row.name),
      };
    });
    const existingById = new Map(existing.map((e) => [e.row.id, e]));

    // --- Matching (DM 1.3, 1.11) -----------------------------------------
    const fits = (event: CalendarEvent, ex: ExistingEvent) =>
      daysApart(event.raceDate, ex.raceDate) <= MATCH_DAYS &&
      normalizeEventName(event.name) === ex.normalizedName;

    const decisions = new Map<CalendarEvent, MatchDecision>();
    const claimed = new Set<string>();

    // 1. The provider's own key, when the event it points at still fits.
    for (const event of incoming) {
      const holderId = eventByKey.get(event.key);
      const holder = holderId ? existingById.get(holderId) : undefined;
      if (holder && fits(event, holder)) {
        decisions.set(event, { type: "match", existing: holder });
        claimed.add(holder.row.id);
      }
    }

    // 2. Season + date (+-3 days) + normalized name, among the unclaimed.
    const strict = new Map<CalendarEvent, ExistingEvent[]>();
    for (const event of incoming) {
      if (decisions.has(event)) continue;
      strict.set(
        event,
        existing.filter((ex) => !claimed.has(ex.row.id) && fits(event, ex)),
      );
    }
    const wantedBy = new Map<string, number>();
    for (const list of strict.values()) {
      if (list.length === 1) {
        wantedBy.set(list[0]!.row.id, (wantedBy.get(list[0]!.row.id) ?? 0) + 1);
      }
    }
    for (const [event, list] of strict) {
      if (list.length === 1 && wantedBy.get(list[0]!.row.id) === 1) {
        decisions.set(event, { type: "match", existing: list[0]! });
      } else if (list.length > 0) {
        decisions.set(event, {
          type: "uncertain",
          reason: "ambiguous",
          candidates: list,
        });
      }
    }
    for (const decision of decisions.values()) {
      if (decision.type === "match") claimed.add(decision.existing.row.id);
    }

    // 3. Nothing fits the rule. If something nearly does (same key, a close
    // date or the same name) the event may have been renamed or moved, so an
    // admin decides. Otherwise it is new.
    for (const event of incoming) {
      if (decisions.has(event)) continue;
      const holderId = eventByKey.get(event.key);
      const near = existing.filter(
        (ex) =>
          !claimed.has(ex.row.id) &&
          (ex.row.id === holderId ||
            daysApart(event.raceDate, ex.raceDate) <= MATCH_DAYS ||
            normalizeEventName(event.name) === ex.normalizedName),
      );
      decisions.set(
        event,
        near.length > 0
          ? { type: "uncertain", reason: "no_strict_match", candidates: near }
          : { type: "new" },
      );
    }

    // 4. A matched event must still be at the same circuit.
    for (const event of incoming) {
      const decision = decisions.get(event)!;
      if (decision.type !== "match") continue;
      const knownCircuit = circuitByKey.get(event.circuit.key);
      const currentKey = circuitKeyById.get(decision.existing.row.circuitId);
      // A circuit with no provider key yet adopts the incoming key, so a
      // circuit an admin created first is not mistaken for a move.
      const sameCircuit =
        knownCircuit !== undefined
          ? knownCircuit === decision.existing.row.circuitId
          : currentKey === undefined;
      if (!sameCircuit) {
        decisions.set(event, {
          type: "uncertain",
          reason: "circuit_changed",
          candidates: [decision.existing],
        });
        claimed.delete(decision.existing.row.id);
      }
    }

    // --- Review items ----------------------------------------------------
    let reviewCount = 0;
    const openReview = async (item: {
      kind: string;
      eventId?: string | null;
      details: Record<string, unknown>;
      dedupeKey: string;
    }) => {
      const opened = await openReviewItem(tx, now, {
        ...item,
        seasonId,
        details: { ...item.details, snapshotId: source.snapshotId },
      });
      if (opened) reviewCount += 1;
    };

    // Events an uncertain item points at stay as they are, and are not also
    // reported missing.
    const heldBack = new Set<string>();
    for (const event of incoming) {
      const decision = decisions.get(event)!;
      if (decision.type !== "uncertain") continue;
      for (const c of decision.candidates) heldBack.add(c.row.id);
      await openReview({
        kind: "uncertain_event_match",
        eventId:
          decision.candidates.length === 1
            ? decision.candidates[0]!.row.id
            : null,
        dedupeKey: `uncertain_match:${season}:${event.key}`,
        details: {
          reason: decision.reason,
          incoming: {
            key: event.key,
            round: event.round,
            name: event.name,
            raceDate: event.raceDate,
            circuit: event.circuit.key,
          },
          candidates: decision.candidates.map((c) => ({
            eventId: c.row.id,
            round: c.row.round,
            name: c.row.name,
            raceDate: c.raceDate,
          })),
        },
      });
    }

    // --- Applying the matched and the new --------------------------------
    const applied = incoming.filter(
      (e) => decisions.get(e)!.type !== "uncertain",
    );

    // A round an applied event takes may be held by one that is not applied
    // (missing from the feed, or held back). Move that one to a free round:
    // `round` is display order only, and it must stay unique at commit.
    const takenRounds = new Set(applied.map((e) => e.round));
    const appliedIds = new Set(
      applied.flatMap((e) => {
        const d = decisions.get(e)!;
        return d.type === "match" ? [d.existing.row.id] : [];
      }),
    );
    let nextFree =
      Math.max(0, ...eventRows.map((e) => e.round), ...takenRounds) + 1;
    for (const ex of existing) {
      if (!appliedIds.has(ex.row.id) && takenRounds.has(ex.row.round)) {
        await tx
          .update(events)
          .set({ round: nextFree, updatedAt: now })
          .where(eq(events.id, ex.row.id));
        nextFree += 1;
      }
    }

    const circuitIds = new Map<string, string>();
    const wantedKeys = new Map<string, string>(); // event id -> provider key
    let created = 0;
    let updated = 0;
    let unchanged = 0;

    /** The circuit row for a provider circuit; true in `changed` when written. */
    const ensureCircuit = async (
      c: CalendarCircuit,
      preferredId?: string,
    ): Promise<{ id: string; changed: boolean }> => {
      const known = circuitIds.get(c.key) ?? circuitByKey.get(c.key);
      if (known) {
        const [row] = await tx
          .select()
          .from(circuits)
          .where(eq(circuits.id, known));
        if (!row) throw new Error(`syncCalendar: circuit ${known} is missing`);
        const patch: Partial<typeof circuits.$inferInsert> = {};
        if (row.name !== c.name) patch.name = c.name;
        if (row.locality !== c.locality) patch.locality = c.locality;
        if (row.country !== c.country) patch.country = c.country;
        if (Number(row.latitude) !== Number(c.latitude))
          patch.latitude = c.latitude;
        if (Number(row.longitude) !== Number(c.longitude)) {
          patch.longitude = c.longitude;
        }
        // The zone is an admin's to set; only a placeholder is replaced.
        if (row.timezone === PLACEHOLDER_TIMEZONE && c.timezone !== null) {
          patch.timezone = c.timezone;
        }
        circuitIds.set(c.key, row.id);
        if (Object.keys(patch).length === 0) {
          return { id: row.id, changed: false };
        }
        await tx
          .update(circuits)
          .set({ ...patch, updatedAt: now })
          .where(eq(circuits.id, row.id));
        return { id: row.id, changed: true };
      }

      if (preferredId) {
        // An existing circuit that had no provider key adopts this one.
        await tx.insert(providerIds).values({
          provider,
          entityType: "circuit",
          providerKey: c.key,
          entityId: preferredId,
          createdAt: now,
          updatedAt: now,
        });
        circuitIds.set(c.key, preferredId);
        return { id: preferredId, changed: true };
      }

      const id = newId();
      const slug = await uniqueSlug(kebab(c.key), async (candidate) => {
        const rows = await tx
          .select({ id: circuits.id })
          .from(circuits)
          .where(eq(circuits.slug, candidate));
        return rows.length > 0;
      });
      await tx.insert(circuits).values({
        id,
        slug,
        name: c.name,
        locality: c.locality,
        country: c.country,
        latitude: c.latitude,
        longitude: c.longitude,
        timezone: c.timezone ?? PLACEHOLDER_TIMEZONE,
        createdAt: now,
        updatedAt: now,
      });
      await tx.insert(providerIds).values({
        provider,
        entityType: "circuit",
        providerKey: c.key,
        entityId: id,
        createdAt: now,
        updatedAt: now,
      });
      circuitIds.set(c.key, id);
      if (c.timezone === null) {
        await openReview({
          kind: "circuit_timezone_missing",
          dedupeKey: `circuit_timezone:${id}`,
          details: { circuitId: id, circuitKey: c.key, name: c.name },
        });
      }
      return { id, changed: true };
    };

    for (const event of applied) {
      const decision = decisions.get(event)!;
      let changed = false;

      const matchedRow =
        decision.type === "match" ? decision.existing.row : null;
      const adoptable =
        matchedRow && !circuitKeyById.has(matchedRow.circuitId)
          ? matchedRow.circuitId
          : undefined;
      const circuit = await ensureCircuit(event.circuit, adoptable);
      changed ||= circuit.changed;

      // The event row.
      let eventId: string;
      let lockAtSource: "default" | "admin" = "default";
      if (matchedRow) {
        eventId = matchedRow.id;
        lockAtSource = matchedRow.lockAtSource;
        const patch: Partial<typeof events.$inferInsert> = {};
        if (matchedRow.round !== event.round) patch.round = event.round;
        if (matchedRow.name !== event.name) patch.name = event.name;
        if (matchedRow.circuitId !== circuit.id) patch.circuitId = circuit.id;
        if (matchedRow.format !== event.format) patch.format = event.format;
        if (Object.keys(patch).length > 0) {
          await tx
            .update(events)
            .set({ ...patch, updatedAt: now })
            .where(eq(events.id, eventId));
          changed = true;
        }
      } else {
        eventId = newId();
        const first = event.sessions.reduce((a, b) =>
          b.start < a.start ? b : a,
        );
        const slug = await uniqueSlug(
          `${season}-${kebab(event.name)}`,
          async (candidate) => {
            const rows = await tx
              .select({ id: events.id })
              .from(events)
              .where(eq(events.slug, candidate));
            return rows.length > 0;
          },
        );
        await tx.insert(events).values({
          id: eventId,
          seasonId,
          round: event.round,
          slug,
          name: event.name,
          circuitId: circuit.id,
          format: event.format,
          status: "scheduled",
          // Replaced below, once the lock session exists.
          lockAt: first.start,
          lockAtSource: "default",
          createdAt: now,
          updatedAt: now,
        });
        changed = true;
      }

      // The sessions. A row an admin timed (`time_source = 'admin'`) keeps
      // its start and end.
      const rowsByKey = new Map(
        (sessionsByEvent.get(eventId) ?? []).map((s) => [
          sessionKey(s.kind, s.sequence),
          s,
        ]),
      );
      const sessionIds = new Map<string, { id: string; start: Date }>();
      for (const s of numbered(event.sessions)) {
        const key = sessionKey(s.kind, s.sequence);
        const end = new Date(s.start.getTime() + durations[s.kind] * MINUTE_MS);
        const row = rowsByKey.get(key);
        if (!row) {
          const id = newId();
          await tx.insert(sessions).values({
            id,
            eventId,
            kind: s.kind,
            sequence: s.sequence,
            scheduledStart: s.start,
            startConfirmed: s.confirmed,
            scheduledEnd: end,
            timeSource: "provider",
            status: "scheduled",
            createdAt: now,
            updatedAt: now,
          });
          sessionIds.set(key, { id, start: s.start });
          changed = true;
        } else if (row.timeSource === "admin") {
          sessionIds.set(key, { id: row.id, start: row.scheduledStart });
        } else {
          sessionIds.set(key, { id: row.id, start: s.start });
          if (
            row.scheduledStart.getTime() !== s.start.getTime() ||
            row.scheduledEnd.getTime() !== end.getTime() ||
            row.startConfirmed !== s.confirmed
          ) {
            await tx
              .update(sessions)
              .set({
                scheduledStart: s.start,
                scheduledEnd: end,
                startConfirmed: s.confirmed,
                updatedAt: now,
              })
              .where(eq(sessions.id, row.id));
            changed = true;
          }
        }
      }

      // The lock: the link to its session is always kept; `lock_at` follows
      // that session unless an admin set it.
      const kind = lockKind(event);
      const lock = kind ? sessionIds.get(sessionKey(kind, 1)) : undefined;
      const [current] = await tx
        .select()
        .from(events)
        .where(eq(events.id, eventId));
      const lockPatch: Partial<typeof events.$inferInsert> = {};
      if (lock && current!.lockSessionId !== lock.id) {
        lockPatch.lockSessionId = lock.id;
      }
      if (lockAtSource === "default") {
        const fallback = event.sessions.reduce((a, b) =>
          b.start < a.start ? b : a,
        ).start;
        const wanted = lock ? lock.start : fallback;
        if (current!.lockAt.getTime() !== wanted.getTime()) {
          lockPatch.lockAt = wanted;
        }
      }
      if (Object.keys(lockPatch).length > 0) {
        await tx
          .update(events)
          .set({ ...lockPatch, updatedAt: now })
          .where(eq(events.id, eventId));
        // A brand-new event's first lock write is part of creating it.
        changed = true;
      }

      wantedKeys.set(eventId, event.key);
      if (decision.type === "new") {
        created += 1;
        // The expected line-up is copied when the event is created (DM 1.9).
        await syncEventEntries(tx, eventId, now);
      } else {
        if (keyByEvent.get(eventId) !== event.key) changed = true;
        if (changed) updated += 1;
        else unchanged += 1;
      }
    }

    // --- Provider keys for events (DM 1.11) -------------------------------
    // A key whose event is no longer at that position goes to its new event.
    // Its old holder keeps its row but loses the key. Moves go through a
    // temporary key because the primary key is not deferrable.
    const wantedKeySet = new Set(wantedKeys.values());
    for (const row of eventKeyRows) {
      if (!wantedKeys.has(row.entityId) && wantedKeySet.has(row.providerKey)) {
        await tx
          .delete(providerIds)
          .where(
            and(
              eq(providerIds.provider, provider),
              eq(providerIds.entityType, "event"),
              eq(providerIds.providerKey, row.providerKey),
            ),
          );
      }
    }
    const moving = [...wantedKeys].filter(
      ([id, key]) => keyByEvent.has(id) && keyByEvent.get(id) !== key,
    );
    for (const [id] of moving) {
      await tx
        .update(providerIds)
        .set({ providerKey: `moving:${id}`, updatedAt: now })
        .where(
          and(
            eq(providerIds.provider, provider),
            eq(providerIds.entityType, "event"),
            eq(providerIds.entityId, id),
          ),
        );
    }
    for (const [id, key] of moving) {
      await tx
        .update(providerIds)
        .set({ providerKey: key, updatedAt: now })
        .where(
          and(
            eq(providerIds.provider, provider),
            eq(providerIds.entityType, "event"),
            eq(providerIds.entityId, id),
          ),
        );
    }
    for (const [id, key] of wantedKeys) {
      if (keyByEvent.has(id)) continue;
      await tx.insert(providerIds).values({
        provider,
        entityType: "event",
        providerKey: key,
        entityId: id,
        createdAt: now,
        updatedAt: now,
      });
    }

    // --- Events the provider no longer lists ------------------------------
    // Never deleted: an admin decides (DM 1.3).
    for (const ex of existing) {
      if (appliedIds.has(ex.row.id) || heldBack.has(ex.row.id)) continue;
      if (ex.row.status === "cancelled") continue;
      await openReview({
        kind: "event_missing_from_provider",
        eventId: ex.row.id,
        dedupeKey: `event_missing:${ex.row.id}`,
        details: {
          name: ex.row.name,
          round: ex.row.round,
          raceDate: ex.raceDate,
          lastKey: ex.key,
        },
      });
    }

    return {
      created,
      updated,
      unchanged,
      reviewItems: reviewCount,
      changed: created + updated,
    };
  });
}
