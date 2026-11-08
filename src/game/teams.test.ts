import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import { seedGame2026 } from "../../tests/helpers/game-2026";
import { gameEvents, games, teams } from "@/db/schema";
import { seedUser } from "../../tests/helpers/users";
import { GameError } from "./errors";
import { createTeam, removeTeam, renameTeam } from "./teams";

// Teams over the recorded 2026 game: up to three per user, none before the
// game opens.

const NOW = new Date("2026-02-01T09:00:00.000Z");

describe("teams (DM 3.6)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let gameId: string;
  let USER: string;

  beforeEach(async () => {
    t = await createTestDb();
    ({ gameId } = await seedGame2026(t.db, NOW));
    USER = await seedUser(t.db);
    await setStatus("open");
  });
  afterEach(async () => {
    await t.close();
  });

  // Opening a game is Task 4's; here the status is set directly.
  const setStatus = (status: "setup" | "open" | "running") =>
    t.db.update(games).set({ status }).where(eq(games.id, gameId));
  const team = async (id: string) => {
    const [row] = await t.db.select().from(teams).where(eq(teams.id, id));
    return row;
  };
  const make = (name: string, userId = USER) =>
    createTeam(t.db, NOW, { gameId, userId, name });

  async function expectGameError(promise: Promise<unknown>, code: string) {
    const error = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(GameError);
    expect((error as GameError).code).toBe(code);
  }

  it("a user gets slots 1, 2 and 3, and a fourth team is refused", async () => {
    const ids = [await make("One"), await make("Two"), await make("Three")];
    const rows = await t.db
      .select()
      .from(teams)
      .where(eq(teams.userId, USER))
      .orderBy(asc(teams.slot));
    expect(rows.map((r) => [r.id, r.slot, r.status])).toEqual([
      [ids[0], 1, "active"],
      [ids[1], 2, "active"],
      [ids[2], 3, "active"],
    ]);
    await expectGameError(make("Four"), "no_free_slot");
    // Another user is unaffected.
    await make("Mine", await seedUser(t.db));
  });

  it("takes the lowest free slot, or the one asked for", async () => {
    const second = await createTeam(t.db, NOW, {
      gameId,
      userId: USER,
      name: "Second",
      slot: 2,
    });
    expect((await team(second))!.slot).toBe(2);
    const first = await make("First");
    expect((await team(first))!.slot).toBe(1);
    await expectGameError(
      createTeam(t.db, NOW, { gameId, userId: USER, name: "Dup", slot: 2 }),
      "no_free_slot",
    );
    await expectGameError(
      createTeam(t.db, NOW, { gameId, userId: USER, name: "Far", slot: 4 }),
      "no_free_slot",
    );
  });

  it("a team can be created while the game is open or running", async () => {
    await setStatus("running");
    await make("Late");
    expect(await t.db.select().from(teams)).toHaveLength(1);
  });

  it("a team can't be created while the game is in setup", async () => {
    await setStatus("setup");
    await expectGameError(make("Early"), "game_not_open");
    expect(await t.db.select().from(teams)).toHaveLength(0);
  });

  it("a blank or over-long name is refused, and a name is trimmed", async () => {
    await expectGameError(make(""), "bad_name");
    await expectGameError(make("   "), "bad_name");
    await expectGameError(make("x".repeat(31)), "bad_name");
    expect(await t.db.select().from(teams)).toHaveLength(0);

    const padded = await make("  Pit Wall  ");
    expect((await team(padded))!.name).toBe("Pit Wall");
    const longest = await make("y".repeat(30));
    expect((await team(longest))!.name).toBe("y".repeat(30));
  });

  it("a rename is trimmed and checked like a new name", async () => {
    const id = await make("Old");
    await renameTeam(t.db, NOW, { teamId: id, name: " New " });
    expect((await team(id))!.name).toBe("New");
    await expectGameError(
      renameTeam(t.db, NOW, { teamId: id, name: " " }),
      "bad_name",
    );
    expect((await team(id))!.name).toBe("New");
  });

  it("a team with no locked event is deleted", async () => {
    const id = await make("Gone");
    expect(await removeTeam(t.db, NOW, id)).toBe("deleted");
    expect(await team(id)).toBeUndefined();
    // Its slot is free again.
    const again = await make("Back");
    expect((await team(again))!.slot).toBe(1);
  });

  it("a team that has locked is retired, not deleted", async () => {
    const id = await make("Veteran");
    const [event] = await t.db.select().from(gameEvents).limit(1);
    await t.db
      .update(teams)
      .set({ firstEventId: event!.eventId })
      .where(eq(teams.id, id));

    expect(await removeTeam(t.db, NOW, id)).toBe("retired");
    expect((await team(id))!.status).toBe("retired");
    // Removing it again changes nothing.
    expect(await removeTeam(t.db, NOW, id)).toBe("retired");
    // A retired team keeps its slot.
    expect((await team(await make("Next")))!.slot).toBe(2);
  });
});
