import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import { games, seasons, type GAME_STATUSES } from "@/db/schema";
import type { Db } from "@/db/types";
import { newId } from "@/lib/ids";
import { currentGame } from "./current-game";

const NOW = new Date("2026-02-01T09:00:00.000Z");

type GameStatus = (typeof GAME_STATUSES)[number];

/** A season of `year` with one fantasy game in `status`. */
async function seasonWithGame(db: Db, year: number, status: GameStatus) {
  const seasonId = newId();
  await db.insert(seasons).values({
    id: seasonId,
    year,
    status: status === "completed" ? "completed" : "active",
    createdAt: NOW,
    updatedAt: NOW,
  });
  const id = newId();
  await db.insert(games).values({
    id,
    seasonId,
    gameType: "season_fantasy",
    slug: `${year}-fantasy`,
    name: `${year} Fantasy`,
    status,
    createdAt: NOW,
    updatedAt: NOW,
  });
  return id;
}

describe("currentGame", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    t = await createTestDb();
  });

  afterEach(async () => {
    await t.close();
  });

  it("none when no game is open or running", async () => {
    expect(await currentGame(t.db)).toBeNull();
    await seasonWithGame(t.db, 2026, "setup");
    expect(await currentGame(t.db)).toBeNull();
  });

  it("an open game is current", async () => {
    const id = await seasonWithGame(t.db, 2026, "open");
    expect(await currentGame(t.db)).toEqual({
      id,
      slug: "2026-fantasy",
      name: "2026 Fantasy",
      status: "open",
      seasonYear: 2026,
    });
  });

  it("the latest season wins", async () => {
    await seasonWithGame(t.db, 2025, "running");
    const id = await seasonWithGame(t.db, 2026, "open");
    await seasonWithGame(t.db, 2024, "running");
    expect(await currentGame(t.db)).toMatchObject({ id, seasonYear: 2026 });
  });

  it("a completed game isn't current", async () => {
    await seasonWithGame(t.db, 2026, "completed");
    expect(await currentGame(t.db)).toBeNull();

    const id = await seasonWithGame(t.db, 2025, "running");
    expect(await currentGame(t.db)).toMatchObject({
      id,
      status: "running",
      seasonYear: 2025,
    });
  });
});
