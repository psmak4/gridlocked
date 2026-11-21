import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { round2026, seedGame2026 } from "../../tests/helpers/game-2026";
import { createTestDb } from "../../tests/helpers/test-db";
import { seedUser } from "../../tests/helpers/users";
import { notifications, poolAssets } from "@/db/schema";
import { openGame, saveLineup } from "@/game/lineups";
import { createTeam } from "@/game/teams";
import { setSimulatedClock } from "@/replay/clock-loop";
import { notifyAvailability } from "./availability";
import { notificationHref } from "./read";
import { type NotificationData, notificationText } from "./text";

const NOW = new Date("2026-02-01T09:00:00.000Z");

describe("availability notices (M8 Task 6)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.close();
  });

  it("an availability notice carries no result and links to the team page", async () => {
    const game = await seedGame2026(t.db, NOW);
    await setSimulatedClock(t.db, NOW);
    await openGame(t.db, NOW, game.gameId);
    const round1 = await round2026(t.db, 1);
    const ada = await seedUser(t.db);
    const teamId = await createTeam(t.db, NOW, {
      gameId: game.gameId,
      userId: ada,
      name: "Ada",
    });
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
    const [asset] = await t.db
      .select({ driverId: poolAssets.driverId })
      .from(poolAssets)
      .where(eq(poolAssets.id, await game.assetId("bearman")));

    expect(
      await notifyAvailability(t.db, NOW, {
        eventId: round1.id,
        driverId: asset!.driverId!,
        status: "unavailable",
      }),
    ).toBe(1);
    const [row] = await t.db.select().from(notifications);
    const data = row!.data as NotificationData;
    // No session: nothing in it is a spoiler, so it's never hidden.
    expect(row).toMatchObject({
      userId: ada,
      kind: "roster_change",
      eventId: round1.id,
      teamId,
      sessionId: null,
    });
    const line = notificationText(row!.kind, data, false);
    expect(line).toEqual({
      label: "YOUR TEAM",
      text: "Bearman is out for the Australian Grand Prix. Check Ada.",
    });
    expect(notificationText(row!.kind, data, true)).toEqual(line);
    expect(notificationHref({ kind: row!.kind, data })).toBe("/team");
    expect(
      notificationText(
        "roster_change",
        {
          driver: "Bearman",
          status: "available",
          event: "Chinese Grand Prix",
          team: "Ada",
        },
        false,
      ).text,
    ).toBe("Bearman is available again for the Chinese Grand Prix. Check Ada.");
  });
});
