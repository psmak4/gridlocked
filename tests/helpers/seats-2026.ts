import type { Db } from "@/db/types";
import {
  parseSeatsFile,
  seedSeats,
  type SeatFixture,
} from "@/providers/import/seats";
import { readFixture } from "./fixtures";

export type { SeatFixture };

export function loadSeats2026(): SeatFixture[] {
  return parseSeatsFile(readFixture("seats-2026.json"));
}

/**
 * Seeds the 2026 season (if missing), the drivers and constructors named in
 * tests/fixtures/seats-2026.json, and the seat assignments (see `seedSeats`).
 * Returns the ids by fixture key.
 */
export function seedSeats2026(db: Db, at: Date) {
  return seedSeats(db, at, 2026, loadSeats2026());
}
