import { eq } from "drizzle-orm";
import { constructors, drivers, seasons, seatAssignments } from "@/db/schema";
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

/**
 * Seeds the 2026 season (if missing), the drivers and constructors named in
 * tests/fixtures/seats-2026.json, and the seat assignments. Names are
 * placeholders built from the Jolpica ids: tests that need real names set them.
 * Returns the driver and constructor ids by fixture key.
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
    const id = newId();
    driverIds.set(key, id);
    await db.insert(drivers).values({
      id,
      slug: kebab(key),
      givenName: key,
      familyName: key,
      nationality: "n/a",
      createdAt: at,
      updatedAt: at,
    });
  }
  for (const key of new Set(seats.map((s) => s.constructor))) {
    const id = newId();
    constructorIds.set(key, id);
    await db.insert(constructors).values({
      id,
      slug: kebab(key),
      name: key,
      nationality: "n/a",
      createdAt: at,
      updatedAt: at,
    });
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
