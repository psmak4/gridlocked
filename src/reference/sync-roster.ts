import { and, eq } from "drizzle-orm";
import {
  constructorSeasons,
  constructors,
  drivers,
  providerIds,
} from "@/db/schema";
import type { Db } from "@/db/types";
import type { Clock } from "@/lib/clock";
import { newId } from "@/lib/ids";
import { teamColors2026 } from "@/design/tokens";
import type {
  RosterConstructor,
  RosterDriver,
  RosterSource,
} from "./roster-types";
import type { SyncReport } from "./calendar-types";
import { openReviewItem } from "./review";
import { ensureSeason } from "./season";
import { kebab, uniqueSlug } from "./slugs";

// Drivers and constructors are written by the calendar sync (DM 1.12). Both
// functions match by provider key through `provider_ids`, never delete, and
// run in one transaction. A second run with the same list writes nothing.

/** Used when no team color is known; an admin sets the real one. */
const PLACEHOLDER_COLOR = "#808080";

/** Team colors by season; only 2026 is defined so far (src/design/tokens.ts). */
function teamColor(season: number, teamCode: string | null): string | null {
  if (season !== 2026 || teamCode === null) return null;
  return teamColors2026[teamCode] ?? null;
}

/**
 * Upserts drivers (DM 1.5). `display_name` is an admin's and is never touched.
 * Drivers are not per season, so `season` only names the run.
 */
export async function syncDrivers(
  db: Db,
  clock: Clock,
  season: number,
  source: RosterSource<RosterDriver>,
): Promise<SyncReport> {
  const provider = source.provider ?? "jolpica";
  const now = clock.now();
  return db.transaction(async (tx) => {
    const keyRows = await tx
      .select()
      .from(providerIds)
      .where(
        and(
          eq(providerIds.provider, provider),
          eq(providerIds.entityType, "driver"),
        ),
      );
    const idByKey = new Map(keyRows.map((r) => [r.providerKey, r.entityId]));
    let created = 0;
    let updated = 0;
    let unchanged = 0;

    for (const d of source.items) {
      const fields = {
        givenName: d.givenName,
        familyName: d.familyName,
        code: d.code,
        permanentNumber: d.permanentNumber,
        nationality: d.nationality,
        dateOfBirth: d.dateOfBirth,
      };
      const knownId = idByKey.get(d.key);
      const [row] = knownId
        ? await tx.select().from(drivers).where(eq(drivers.id, knownId))
        : [];
      if (row) {
        const patch: Partial<typeof fields> = {};
        for (const k of Object.keys(fields) as Array<keyof typeof fields>) {
          if (row[k] !== fields[k]) Object.assign(patch, { [k]: fields[k] });
        }
        if (Object.keys(patch).length === 0) {
          unchanged += 1;
          continue;
        }
        await tx
          .update(drivers)
          .set({ ...patch, updatedAt: now })
          .where(eq(drivers.id, row.id));
        updated += 1;
        continue;
      }

      const id = newId();
      const slug = await uniqueSlug(kebab(d.key), async (candidate) => {
        const taken = await tx
          .select({ id: drivers.id })
          .from(drivers)
          .where(eq(drivers.slug, candidate));
        return taken.length > 0;
      });
      await tx
        .insert(drivers)
        .values({ id, slug, ...fields, createdAt: now, updatedAt: now });
      await tx.insert(providerIds).values({
        provider,
        entityType: "driver",
        providerKey: d.key,
        entityId: id,
        createdAt: now,
        updatedAt: now,
      });
      idByKey.set(d.key, id);
      created += 1;
    }
    return {
      created,
      updated,
      unchanged,
      reviewItems: 0,
      changed: created + updated,
    };
  });
}

/**
 * Upserts constructors (DM 1.6) and gives each a `constructor_seasons` row for
 * `season` (DM 1.7) if it has none. An existing season row is an admin's to
 * edit and is left alone, except that a placeholder color is replaced once a
 * real one is known. A constructor with no known color gets a placeholder and
 * a `missing_constructor_color` warning.
 */
export async function syncConstructors(
  db: Db,
  clock: Clock,
  season: number,
  source: RosterSource<RosterConstructor>,
): Promise<SyncReport> {
  const provider = source.provider ?? "jolpica";
  const now = clock.now();
  return db.transaction(async (tx) => {
    const seasonRow = await ensureSeason(tx, season, now);
    const keyRows = await tx
      .select()
      .from(providerIds)
      .where(
        and(
          eq(providerIds.provider, provider),
          eq(providerIds.entityType, "constructor"),
        ),
      );
    const idByKey = new Map(keyRows.map((r) => [r.providerKey, r.entityId]));
    let created = 0;
    let updated = 0;
    let unchanged = 0;
    let reviewCount = 0;

    for (const c of source.items) {
      let changed = false;
      let id = idByKey.get(c.key);
      const [row] = id
        ? await tx.select().from(constructors).where(eq(constructors.id, id))
        : [];

      if (row) {
        if (row.name !== c.name || row.nationality !== c.nationality) {
          await tx
            .update(constructors)
            .set({ name: c.name, nationality: c.nationality, updatedAt: now })
            .where(eq(constructors.id, row.id));
          changed = true;
        }
      } else {
        id = newId();
        const slug = await uniqueSlug(kebab(c.key), async (candidate) => {
          const taken = await tx
            .select({ id: constructors.id })
            .from(constructors)
            .where(eq(constructors.slug, candidate));
          return taken.length > 0;
        });
        await tx.insert(constructors).values({
          id,
          slug,
          name: c.name,
          nationality: c.nationality,
          createdAt: now,
          updatedAt: now,
        });
        await tx.insert(providerIds).values({
          provider,
          entityType: "constructor",
          providerKey: c.key,
          entityId: id,
          createdAt: now,
          updatedAt: now,
        });
        idByKey.set(c.key, id);
        changed = true;
      }

      // The season entry.
      const known = teamColor(season, c.teamCode);
      const [entry] = await tx
        .select()
        .from(constructorSeasons)
        .where(
          and(
            eq(constructorSeasons.constructorId, id!),
            eq(constructorSeasons.seasonId, seasonRow.id),
          ),
        );
      if (!entry) {
        await tx.insert(constructorSeasons).values({
          constructorId: id!,
          seasonId: seasonRow.id,
          displayName: c.name,
          shortName: c.name,
          color: known ?? PLACEHOLDER_COLOR,
          createdAt: now,
          updatedAt: now,
        });
        changed = true;
      } else if (known && entry.color === PLACEHOLDER_COLOR) {
        await tx
          .update(constructorSeasons)
          .set({ color: known, updatedAt: now })
          .where(
            and(
              eq(constructorSeasons.constructorId, id!),
              eq(constructorSeasons.seasonId, seasonRow.id),
            ),
          );
        changed = true;
      }
      const color =
        entry && entry.color !== PLACEHOLDER_COLOR ? entry.color : known;
      if (!color) {
        const opened = await openReviewItem(tx, now, {
          kind: "missing_constructor_color",
          seasonId: seasonRow.id,
          dedupeKey: `constructor_color:${season}:${id}`,
          details: {
            constructorId: id,
            providerKey: c.key,
            name: c.name,
            snapshotId: source.snapshotId,
          },
        });
        if (opened) reviewCount += 1;
      }

      if (!row) created += 1;
      else if (changed) updated += 1;
      else unchanged += 1;
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
