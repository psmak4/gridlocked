import { and, eq } from "drizzle-orm";
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
import { readFixture } from "./fixtures";

export interface SeatFixture {
  driver: string;
  constructor: string;
  carNumber: number;
  role: "race" | "reserve";
  validFrom: string;
  validTo: string | null;
}

export function loadSeats2026(): SeatFixture[] {
  return (readFixture("seats-2026.json") as { seats: SeatFixture[] }).seats;
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
 * Seeds the 2026 season (if missing), the drivers and constructors named in
 * tests/fixtures/seats-2026.json, and the seat assignments. Drivers and
 * constructors that `syncDrivers` / `syncConstructors` already created are
 * found through `provider_ids` and reused; any missing one is created with a
 * placeholder name built from its Jolpica id and given a `provider_ids` row,
 * so a later sync adopts it. Returns the ids by fixture key.
 */
export async function seedSeats2026(db: Db, at: Date) {
  let [season] = await db.select().from(seasons).where(eq(seasons.year, 2026));
  if (!season) {
    [season] = await db
      .insert(seasons)
      .values({ id: newId(), year: 2026, status: "active" })
      .returning();
  }
  const seats = loadSeats2026();

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
  for (const seat of seats) {
    await db.insert(seatAssignments).values({
      id: newId(),
      seasonId: season!.id,
      driverId: driverIds.get(seat.driver)!,
      constructorId: constructorIds.get(seat.constructor)!,
      carNumber: seat.carNumber,
      role: seat.role,
      validFrom: seat.validFrom,
      validTo: seat.validTo,
      createdAt: at,
      updatedAt: at,
    });
  }
  return { seasonId: season!.id, driverIds, constructorIds };
}
