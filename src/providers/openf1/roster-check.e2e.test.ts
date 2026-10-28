import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../../tests/helpers/test-db";
import { readFixture } from "../../../tests/helpers/fixtures";
import { sessionIdFor } from "../../../tests/helpers/results-2026";
import {
  idFor,
  seedEntriesFor,
  seedWorldWithSeats,
} from "../../../tests/helpers/ingest-2026";
import { eventEntries, reviewItems } from "@/db/schema";
import { rosterCheck } from "@/reference/roster-check";
import { storeSnapshot } from "../snapshots";
import { parseOpenF1Drivers, storeParticipants } from "./participants";

// The recorded OpenF1 practice fixtures, through storeParticipants and then
// the roster check, against entries built from the seats.

const NOW = new Date("2026-09-05T12:00:00.000Z");

describe("OpenF1 practice -> roster check", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeEach(async () => {
    t = await createTestDb();
    await seedWorldWithSeats(t.db);
  });
  afterEach(async () => {
    await t.close();
  });

  async function storeRecorded(sessionId: string, file: string) {
    const body = readFixture(`openf1/2026/${file}`);
    const { id } = await storeSnapshot(t.db, {
      provider: "openf1",
      endpoint: "/drivers",
      params: { file },
      body,
      now: NOW,
      sessionId,
    });
    await storeParticipants(t.db, NOW, sessionId, id, parseOpenF1Drivers(body));
  }

  const items = () => t.db.select().from(reviewItems);

  it("round 13 FP2 and FP3 agree with the swap entries", async () => {
    const fp2 = await sessionIdFor(t.db, 13, "fp2");
    const fp3 = await sessionIdFor(t.db, 13, "fp3");
    const eventId = await seedEntriesFor(t.db, fp2);
    await storeRecorded(fp2, "drivers-r13-fp2.json");
    await storeRecorded(fp3, "drivers-r13-fp3.json");

    expect(await rosterCheck(t.db, NOW, eventId)).toEqual([]);
    expect(await items()).toEqual([]);
  });

  it("round 15 FP2 agrees with the reversed entries", async () => {
    const fp2 = await sessionIdFor(t.db, 15, "fp2");
    const eventId = await seedEntriesFor(t.db, fp2);
    await storeRecorded(fp2, "drivers-r15-fp2.json");

    expect(await rosterCheck(t.db, NOW, eventId)).toEqual([]);
    expect(await items()).toEqual([]);
  });

  it("against the pre-swap line-up, round 13 shows the swap", async () => {
    // Round 1's line-up: Hadjar at Red Bull, Lawson at Racing Bulls.
    const round1 = await seedEntriesFor(
      t.db,
      await sessionIdFor(t.db, 1, "fp1"),
    );
    const fp2 = await sessionIdFor(t.db, 13, "fp2");
    const eventId = await seedEntriesFor(t.db, fp2);
    await t.db.delete(eventEntries).where(eq(eventEntries.eventId, eventId));
    const preSwap = await t.db
      .select()
      .from(eventEntries)
      .where(eq(eventEntries.eventId, round1));
    await t.db
      .insert(eventEntries)
      .values(preSwap.map((e) => ({ ...e, eventId })));

    await storeRecorded(fp2, "drivers-r13-fp2.json");
    const problems = await rosterCheck(t.db, NOW, eventId);

    const lawson = await idFor(t.db, "driver", "lawson");
    const tsunoda = await idFor(t.db, "driver", "tsunoda");
    const hadjar = await idFor(t.db, "driver", "hadjar");
    const redBull = await idFor(t.db, "constructor", "red_bull");
    const rb = await idFor(t.db, "constructor", "rb");
    const found = problems.map((p) => [p.kind, p.details.driverId]);
    expect(found).toHaveLength(3);
    expect(found).toEqual(
      expect.arrayContaining([
        ["team_change", lawson],
        ["team_change", tsunoda],
        ["missing_driver", hadjar],
      ]),
    );
    expect(
      problems.find((p) => p.details.driverId === lawson)!.details,
    ).toMatchObject({ constructorId: redBull, expectedConstructorId: rb });
    expect(
      problems.find((p) => p.details.driverId === tsunoda)!.details,
    ).toMatchObject({ constructorId: rb, expectedConstructorId: null });
    expect(await items()).toHaveLength(3);
  });
});
