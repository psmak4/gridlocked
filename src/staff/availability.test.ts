import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { round2026, seedGame2026 } from "../../tests/helpers/game-2026";
import { createTestDb } from "../../tests/helpers/test-db";
import { seedUser } from "../../tests/helpers/users";
import {
  auditLog,
  driverAvailability,
  notifications,
  poolAssets,
} from "@/db/schema";
import { openGame, saveLineup } from "@/game/lineups";
import { createTeam } from "@/game/teams";
import { setSimulatedClock } from "@/replay/clock-loop";
import { setAvailability, seatTable } from "./availability";
import { StaffError } from "./errors";
import { changeSeats, type StaffActor } from "./roster";

const NOW = new Date("2026-02-01T09:00:00.000Z");
const HOUR = 3_600_000;

describe("staff availability and seats (M8 Task 6)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let game: Awaited<ReturnType<typeof seedGame2026>>;
  let actor: StaffActor;
  let round1: { id: string; lockAt: Date };
  let bearman: string;

  beforeEach(async () => {
    t = await createTestDb();
    game = await seedGame2026(t.db, NOW);
    await setSimulatedClock(t.db, NOW);
    await openGame(t.db, NOW, game.gameId);
    round1 = await round2026(t.db, 1);
    const admin = await seedUser(t.db, { role: "admin" });
    actor = { kind: "admin", label: null, userId: admin, requestId: "web:1" };
    const [asset] = await t.db
      .select({ driverId: poolAssets.driverId })
      .from(poolAssets)
      .where(eq(poolAssets.id, await game.assetId("bearman")));
    bearman = asset!.driverId!;
  });
  afterEach(async () => {
    await t.close();
  });

  /** A team for `userId` with a full lineup, with Bearman or without. */
  const teamWith = async (userId: string, name: string, withBearman = true) => {
    const teamId = await createTeam(t.db, NOW, {
      gameId: game.gameId,
      userId,
      name,
    });
    if (!withBearman) return teamId;
    // 280 + 250 + 95 + 85 + 80 + 90 + 70 = 950, under the cap.
    const picks = await Promise.all(
      [
        "norris",
        "piastri",
        "hulkenberg",
        "hadjar",
        "bearman",
        "haas",
        "audi",
      ].map(async (key, i) => ({
        assetId: await game.assetId(key),
        isBoost: i === 0,
      })),
    );
    await saveLineup(t.db, NOW, { teamId, picks, basedOnVersionId: null });
    return teamId;
  };
  const audits = () =>
    t.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "driver_availability.update"));
  const notices = () =>
    t.db
      .select()
      .from(notifications)
      .where(eq(notifications.kind, "roster_change"));

  it("setAvailability writes the row, audits driver_availability.update with before and after, and notifies each owner once", async () => {
    const ada = await seedUser(t.db);
    const bo = await seedUser(t.db);
    const cy = await seedUser(t.db);
    await teamWith(ada, "Ada One");
    await teamWith(ada, "Ada Two");
    await teamWith(bo, "Bo");
    await teamWith(cy, "Cy", false);

    const first = await setAvailability(t.db, NOW, actor, {
      eventId: round1.id,
      driverId: bearman,
      status: "doubtful",
      note: "Unwell, the team decides on Friday",
      reason: "Unwell, the team decides on Friday",
    });
    expect(first).toEqual({ owners: 2 });
    const [row] = await t.db
      .select()
      .from(driverAvailability)
      .where(
        and(
          eq(driverAvailability.eventId, round1.id),
          eq(driverAvailability.driverId, bearman),
        ),
      );
    expect(row).toMatchObject({
      status: "doubtful",
      reason: "Unwell, the team decides on Friday",
      source: "admin",
    });
    expect((await notices()).map((n) => n.userId).sort()).toEqual(
      [ada, bo].sort(),
    );
    expect((await notices())[0]).toMatchObject({
      eventId: round1.id,
      sessionId: null,
      data: { status: "doubtful", driver: "Bearman" },
    });

    await setAvailability(t.db, NOW, actor, {
      eventId: round1.id,
      driverId: bearman,
      status: "unavailable",
      note: "Out: Ocon drives",
      reason: "Out: Ocon drives",
    });
    const rows = await audits();
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      actorUserId: actor.userId,
      entityType: "driver_availability",
      entityId: round1.id,
      before: {
        driverId: bearman,
        status: "doubtful",
        note: "Unwell, the team decides on Friday",
      },
      after: {
        driverId: bearman,
        status: "unavailable",
        note: "Out: Ocon drives",
      },
      reason: "Out: Ocon drives",
    });
    // Each owner's notice counts into their unread one.
    expect(await notices()).toHaveLength(2);
    expect(
      (await notices()).map((n) => (n.data as { status: string }).status),
    ).toEqual(["unavailable", "unavailable"]);
  });

  it("setAvailability with the same status and note writes nothing and notifies no one", async () => {
    await teamWith(await seedUser(t.db), "Ada");
    const input = {
      eventId: round1.id,
      driverId: bearman,
      status: "doubtful" as const,
      note: "Unwell",
      reason: "Unwell",
    };
    await setAvailability(t.db, NOW, actor, input);
    const before = await notices();
    expect(await setAvailability(t.db, NOW, actor, input)).toEqual({
      owners: 0,
    });
    expect(await audits()).toHaveLength(1);
    expect(await notices()).toEqual(before);
  });

  it("setAvailability for an event that has locked is refused with event_locked", async () => {
    const after = new Date(round1.lockAt.getTime() + HOUR);
    const error = await setAvailability(t.db, after, actor, {
      eventId: round1.id,
      driverId: bearman,
      status: "unavailable",
      note: "Too late",
      reason: "Too late",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StaffError);
    expect((error as StaffError).code).toBe("event_locked");
    expect(await audits()).toHaveLength(0);
  });

  it("seatTable shows seats as date ranges with rounds, and an open seat as Open", async () => {
    const round3 = await round2026(t.db, 3);
    await changeSeats(t.db, NOW, {
      fromEventId: round3.id,
      changes: [{ driverId: bearman, constructorId: null }],
      reason: "Leaves the team",
      actor,
    });
    const table = await seatTable(t.db, 2026);
    expect(table.teams.length).toBeGreaterThan(5);
    const seat = table.seats.find((s) => s.driverId === bearman)!;
    expect(seat).toMatchObject({ driver: "Bearman", role: "Race" });
    expect(seat.from).toMatch(/^\d{1,2} [A-Z][a-z]{2} \(rd 1\)$/);
    expect(seat.until).toMatch(/^\d{1,2} [A-Z][a-z]{2} \(rd 2\)$/);
    const open = table.seats.find((s) => s.driverId !== bearman)!;
    expect(open.until).toBe("Open");
    // One team's tab.
    const haas = table.teams.find((tm) => tm.name.includes("Haas"))!;
    const only = await seatTable(t.db, 2026, haas.slug);
    expect(new Set(only.seats.map((s) => s.team))).toEqual(
      new Set([haas.slug]),
    );
  });
});
