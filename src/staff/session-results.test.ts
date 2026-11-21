import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import {
  idFor,
  ingest,
  seedEntriesFor,
  seedWorldWithSeats,
} from "../../tests/helpers/ingest-2026";
import { loadBody, sessionIdFor } from "../../tests/helpers/results-2026";
import { round2026, seedGame2026 } from "../../tests/helpers/game-2026";
import { seedUser } from "../../tests/helpers/users";
import { jobs, resultChanges, sessionResultState } from "@/db/schema";
import { newId } from "@/lib/ids";
import { openGame, saveLineup } from "@/game/lineups";
import { createTeam } from "@/game/teams";
import { advanceStatus } from "@/results/status";
import { setSimulatedClock } from "@/replay/clock-loop";
import { overrideResult } from "./results";
import type { StaffActor } from "./roster";
import { checkProviderAgain, sessionResults } from "./session-results";

const T0 = new Date("2026-08-01T15:00:00.000Z");
const T1 = new Date("2026-08-01T16:00:00.000Z");
const T2 = new Date("2026-08-01T17:00:00.000Z");
const ACTOR: StaffActor = { kind: "admin", label: null, requestId: "r1" };

describe("sessionResults and checkProviderAgain (M8 Task 7)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  afterEach(async () => {
    await t.close();
  });

  describe("round 14's qualifying", () => {
    let sessionId: string;
    let snapshotId: string;
    beforeEach(async () => {
      t = await createTestDb();
      await seedWorldWithSeats(t.db);
      sessionId = await sessionIdFor(t.db, 14, "qualifying");
      await seedEntriesFor(t.db, sessionId);
      snapshotId = await ingest(
        t.db,
        T0,
        sessionId,
        "qualifying",
        loadBody("jolpica/2026/r14-qualifying.json"),
      );
      await advanceStatus(t.db, T0, sessionId);
    });

    it("sessionResults marks overridden rows and lists result_changes newest first", async () => {
      const norris = await idFor(t.db, "driver", "norris");
      const albon = await idFor(t.db, "driver", "albon");
      await overrideResult(t.db, T1, {
        sessionId,
        driverId: norris,
        fields: { position: 2 },
        reason: "Lap time deleted for track limits",
        actor: ACTOR,
      });
      await t.db.insert(resultChanges).values([
        {
          id: newId(),
          sessionId,
          driverId: albon,
          field: "position",
          oldValue: "8",
          newValue: "9",
          fromSnapshotId: snapshotId,
          toSnapshotId: snapshotId,
          detectedAt: T1,
        },
        {
          id: newId(),
          sessionId,
          driverId: norris,
          field: "position",
          oldValue: "3",
          newValue: "1",
          fromSnapshotId: snapshotId,
          toSnapshotId: snapshotId,
          detectedAt: T2,
        },
      ]);

      const view = await sessionResults(t.db, sessionId);
      expect(view).not.toBeNull();
      const norrisRow = view!.rows.find((r) => r.driverId === norris)!;
      expect(norrisRow).toMatchObject({
        pos: "2",
        overridden: true,
        overrideReason: "Lap time deleted for track limits",
        changed: "Corrected",
      });
      const albonRow = view!.rows.find((r) => r.driverId === albon)!;
      expect(albonRow).toMatchObject({
        overridden: false,
        changed: "Down from P8",
      });
      expect(view!.changes.map((c) => c.detectedAt)).toEqual([T2, T1]);
      expect(view!.changes[0]).toMatchObject({
        driverId: norris,
        what: "Norris: P3 → P1",
      });
      expect(view!.overrides).toEqual([
        expect.objectContaining({
          driverId: norris,
          kind: "patch",
          reason: "Lap time deleted for track limits",
          active: true,
        }),
      ]);
      // Short of its two no-time drivers.
      expect(view!.status).toBe("awaiting");
      expect(view!.source).toMatchObject({
        kind: "provider",
        provider: "jolpica",
      });
      // Rows come in finishing order, the corrected place included.
      const places = view!.rows.map((r) => r.position ?? 99);
      expect(places).toEqual([...places].sort((a, b) => a - b));
    });

    it("sessionResults is null for a session that doesn't exist", async () => {
      expect(await sessionResults(t.db, newId())).toBeNull();
    });

    it("checkProviderAgain queues one poll, deduped", async () => {
      const first = await checkProviderAgain(t.db, T1, { sessionId });
      const second = await checkProviderAgain(t.db, T2, { sessionId });
      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      const polls = await t.db
        .select()
        .from(jobs)
        .where(and(eq(jobs.kind, "poll_session"), eq(jobs.status, "pending")));
      expect(polls).toHaveLength(1);
      expect(polls[0]!.payload).toMatchObject({ sessionId });
      // The second press moved it to now rather than queueing another.
      expect(polls[0]!.runAt).toEqual(T2);
    });

    it("checkProviderAgain refuses a final session", async () => {
      await t.db
        .update(sessionResultState)
        .set({ status: "final" })
        .where(eq(sessionResultState.sessionId, sessionId));
      await expect(
        checkProviderAgain(t.db, T1, { sessionId }),
      ).rejects.toMatchObject({ code: "session_final" });
      expect(
        await t.db.select().from(jobs).where(eq(jobs.kind, "poll_session")),
      ).toHaveLength(0);
    });
  });

  it("owners counts teams that own the driver or their constructor for the event", async () => {
    t = await createTestDb();
    const now = new Date("2026-02-01T09:00:00.000Z");
    const game = await seedGame2026(t.db, now);
    await setSimulatedClock(t.db, now);
    await openGame(t.db, now, game.gameId);
    const round1 = await round2026(t.db, 1);
    const sessionId = await sessionIdFor(t.db, 1, "race");
    const lineup = async (name: string, keys: string[]) => {
      const teamId = await createTeam(t.db, now, {
        gameId: game.gameId,
        userId: await seedUser(t.db),
        name,
      });
      const picks = await Promise.all(
        keys.map(async (key, i) => ({
          assetId: await game.assetId(key),
          isBoost: i === 0,
        })),
      );
      await saveLineup(t.db, now, { teamId, picks, basedOnVersionId: null });
    };
    // Ada has Bearman and Haas; Bo has Haas only; Cy has neither.
    await lineup("Ada", [
      "norris",
      "piastri",
      "hulkenberg",
      "hadjar",
      "bearman",
      "haas",
      "audi",
    ]);
    await lineup("Bo", [
      "norris",
      "piastri",
      "hulkenberg",
      "hadjar",
      "ocon",
      "haas",
      "audi",
    ]);
    await lineup("Cy", [
      "norris",
      "bottas",
      "perez",
      "colapinto",
      "albon",
      "williams",
      "audi",
    ]);

    const view = await sessionResults(t.db, sessionId);
    expect(view!.event.id).toBe(round1.id);
    const bearman = await idFor(t.db, "driver", "bearman");
    const norris = await idFor(t.db, "driver", "norris");
    const albon = await idFor(t.db, "driver", "albon");
    expect(view!.owners[bearman]).toBe(2);
    expect(view!.owners[norris]).toBe(3);
    expect(view!.owners[albon]).toBe(1);
  });
});
