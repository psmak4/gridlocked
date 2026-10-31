// Test helper for code outside the adapters (src/staff) that needs stored
// OpenF1 practice participants: the adapters' own functions, re-exported.
import type { Db } from "@/db/types";
import { storeSnapshot } from "@/providers/snapshots";
import {
  parseOpenF1Drivers,
  rematchParticipants,
  storeParticipants,
} from "@/providers/openf1/participants";
import { readFixture } from "./fixtures";

export { rematchParticipants };

export type OpenF1DriverRow = Record<string, unknown> & {
  driver_number: number;
  name_acronym: string;
  team_name: string;
};

/** A recorded OpenF1 `drivers` body, as a copy safe to edit. */
export const loadOpenF1Drivers = (file: string) =>
  structuredClone(readFixture(`openf1/2026/${file}`)) as OpenF1DriverRow[];

/** Stores `body` as the session's OpenF1 `drivers` answer and its participants. */
export async function storeOpenF1Participants(
  db: Db,
  now: Date,
  sessionId: string,
  body: OpenF1DriverRow[],
) {
  const { id } = await storeSnapshot(db, {
    provider: "openf1",
    endpoint: "/drivers",
    params: { session: sessionId },
    body,
    now,
    sessionId,
  });
  await storeParticipants(db, now, sessionId, id, parseOpenF1Drivers(body));
  return id;
}
