import { and, eq } from "drizzle-orm";
import { z } from "zod";
import {
  constructors,
  drivers,
  providerIds,
  seasons,
  seatAssignments,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { newId } from "@/lib/ids";
import { kebab } from "@/reference/slugs";

// The season's race and reserve seats, from a seats file (the shape of
// tests/fixtures/seats-2026.json). Seats are our own data, but the file names
// drivers and constructors by Jolpica key, so this stays with the adapters:
// only src/providers may read `provider_ids`.

const seatSchema = z.object({
  driver: z.string(),
  constructor: z.string(),
  carNumber: z.number().int(),
  role: z.enum(["race", "reserve"]),
  validFrom: z.string(),
  validTo: z.string().nullable(),
});
export type SeatFixture = z.infer<typeof seatSchema>;

const seatsFileSchema = z.object({ seats: z.array(seatSchema) });

/** Reads a seats file's parsed JSON. Throws on a shape we do not know. */
export function parseSeatsFile(body: unknown): SeatFixture[] {
  return seatsFileSchema.parse(body).seats;
}

const PROVIDER = "jolpica";

/** The id mapped to a Jolpica key, or a new row from `create` (and its mapping). */
async function findOrCreate(
  db: Db,
  entityType: "driver" | "constructor",
  key: string,
  at: Date,
  create: (id: string) => Promise<void>,
): Promise<string> {
  const [mapped] = await db
    .select({ id: providerIds.entityId })
    .from(providerIds)
    .where(
      and(
        eq(providerIds.provider, PROVIDER),
        eq(providerIds.entityType, entityType),
        eq(providerIds.providerKey, key),
      ),
    );
  if (mapped) return mapped.id;
  const id = newId();
  await create(id);
  await db.insert(providerIds).values({
    provider: PROVIDER,
    entityType,
    providerKey: key,
    entityId: id,
    createdAt: at,
    updatedAt: at,
  });
  return id;
}

/**
 * Seeds the season (if missing), the drivers and constructors the seats name,
 * and the seat assignments. Drivers and constructors that `syncDrivers` /
 * `syncConstructors` already created are found through `provider_ids` and
 * reused; any missing one is created with a placeholder name built from its
 * Jolpica id and given a `provider_ids` row, so a later sync adopts it.
 * Returns the ids by Jolpica key.
 *
 * Safe to run again: a seat already stored (same season, driver, constructor,
 * number, role and start date) is left as it is.
 */
export async function seedSeats(
  db: Db,
  at: Date,
  year: number,
  seats: SeatFixture[],
) {
  let [season] = await db.select().from(seasons).where(eq(seasons.year, year));
  if (!season) {
    [season] = await db
      .insert(seasons)
      .values({ id: newId(), year, status: "active" })
      .returning();
  }

  const driverIds = new Map<string, string>();
  const constructorIds = new Map<string, string>();
  for (const key of new Set(seats.map((s) => s.driver))) {
    driverIds.set(
      key,
      await findOrCreate(db, "driver", key, at, async (id) => {
        await db.insert(drivers).values({
          id,
          slug: kebab(key),
          givenName: key,
          familyName: key,
          nationality: "n/a",
          createdAt: at,
          updatedAt: at,
        });
      }),
    );
  }
  for (const key of new Set(seats.map((s) => s.constructor))) {
    constructorIds.set(
      key,
      await findOrCreate(db, "constructor", key, at, async (id) => {
        await db.insert(constructors).values({
          id,
          slug: kebab(key),
          name: key,
          nationality: "n/a",
          createdAt: at,
          updatedAt: at,
        });
      }),
    );
  }

  const stored = await db
    .select()
    .from(seatAssignments)
    .where(eq(seatAssignments.seasonId, season!.id));
  const seatKey = (s: {
    driverId: string;
    constructorId: string;
    carNumber: number;
    role: string;
    validFrom: string;
  }) =>
    [s.driverId, s.constructorId, s.carNumber, s.role, s.validFrom].join("|");
  const have = new Set(stored.map(seatKey));

  for (const seat of seats) {
    const row = {
      driverId: driverIds.get(seat.driver)!,
      constructorId: constructorIds.get(seat.constructor)!,
      carNumber: seat.carNumber,
      role: seat.role,
      validFrom: seat.validFrom,
    };
    if (have.has(seatKey(row))) continue;
    await db.insert(seatAssignments).values({
      id: newId(),
      seasonId: season!.id,
      ...row,
      validTo: seat.validTo,
      createdAt: at,
      updatedAt: at,
    });
  }
  return { seasonId: season!.id, driverIds, constructorIds };
}
