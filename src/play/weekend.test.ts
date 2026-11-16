import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { round2026, seedGame2026 } from "../../tests/helpers/game-2026";
import { createTestDb } from "../../tests/helpers/test-db";
import { seedUser } from "../../tests/helpers/users";
import { gameEvents, sessions, type GAME_EVENT_STATUSES } from "@/db/schema";
import type { Db } from "@/db/types";
import { openGame } from "@/game/lineups";
import { newId } from "@/lib/ids";
import { markWatched } from "@/spoilers/reveal";
import { sessionState, weekendFor, type SessionState } from "./weekend";

const SEEDED = new Date("2026-02-01T09:00:00.000Z");
const HOUR = 3_600_000;

describe("sessionState", () => {
  const start = new Date("2026-03-07T05:00:00.000Z");
  const end = new Date("2026-03-07T06:00:00.000Z");
  const before = new Date(start.getTime() - HOUR);
  const during = new Date(start.getTime() + 30 * 60_000);
  const after = new Date(end.getTime() + HOUR);

  const cases: Array<
    [
      string,
      Parameters<typeof sessionState>[0]["status"],
      boolean,
      Date,
      SessionState,
    ]
  > = [
    ["scheduled before its start", "scheduled", true, before, "scheduled"],
    ["a start not confirmed is tbc", "scheduled", false, before, "tbc"],
    ["between start and end is live", "scheduled", true, during, "live"],
    ["live by the provider", "live", true, before, "live"],
    [
      "a suspended session is a red flag",
      "suspended",
      true,
      during,
      "red_flag",
    ],
    [
      "an abandoned session ended early",
      "abandoned",
      true,
      after,
      "ended_early",
    ],
    ["a cancelled session", "cancelled", true, before, "cancelled"],
    ["completed is ended", "completed", true, during, "ended"],
    [
      "past its end, still scheduled, is ended",
      "scheduled",
      true,
      after,
      "ended",
    ],
    [
      "past its end, not confirmed, is ended",
      "scheduled",
      false,
      after,
      "ended",
    ],
  ];

  it.each(cases)("%s", (_name, status, startConfirmed, now, expected) => {
    expect(sessionState({ status, startConfirmed, start, end }, now)).toBe(
      expected,
    );
  });
});

describe("weekendFor", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: Db;
  let gameId: string;

  beforeEach(async () => {
    t = await createTestDb();
    db = t.db as unknown as Db;
    ({ gameId } = await seedGame2026(db, SEEDED));
  });

  afterEach(async () => {
    await t.close();
  });

  type Status = (typeof GAME_EVENT_STATUSES)[number];
  async function setRound(round: number, status: Status) {
    const { id } = await round2026(db, round);
    await db
      .update(gameEvents)
      .set({
        status,
        ...(status === "cancelled" ? { sequence: null } : {}),
        updatedAt: SEEDED,
      })
      .where(and(eq(gameEvents.gameId, gameId), eq(gameEvents.eventId, id)));
  }

  const weekend = (
    now = SEEDED,
    reader: Parameters<typeof weekendFor>[2]["reader"] = null,
  ) => weekendFor(db, now, { gameId, reader });

  it("the open event is the weekend", async () => {
    await openGame(db, SEEDED, gameId);
    const round1 = await round2026(db, 1);
    const found = await weekend();
    expect(found).toMatchObject({
      eventId: round1.id,
      round: 1,
      lockAt: round1.lockAt.toISOString(),
    });
    expect(found!.name).toMatch(/Grand Prix$/);
    expect(found!.circuitTimeZone).toMatch(/^[A-Za-z]+\/[A-Za-z_]+$/);
    expect(found!.sessions.map((s) => [s.label, s.state])).toEqual([
      ["Practice 1", "scheduled"],
      ["Practice 2", "scheduled"],
      ["Practice 3", "scheduled"],
      ["Qualifying", "scheduled"],
      ["Race", "scheduled"],
    ]);
  });

  it("after the lock it stays until the next opens", async () => {
    await openGame(db, SEEDED, gameId);
    await setRound(1, "locked");
    expect((await weekend())!.round).toBe(1);
    await setRound(1, "final");
    expect((await weekend())!.round).toBe(1);
    await setRound(2, "open");
    expect((await weekend())!.round).toBe(2);
  });

  it("a cancelled event is skipped", async () => {
    // Before the game opens, the hub shows the next upcoming event.
    expect((await weekend())!.round).toBe(1);
    await setRound(1, "cancelled");
    expect((await weekend())!.round).toBe(2);
  });

  it("Locks team is on qualifying, and on sprint qualifying at a sprint weekend", async () => {
    await openGame(db, SEEDED, gameId);
    const locks = async () =>
      (await weekend())!.sessions
        .filter((s) => s.locksTeam)
        .map((s) => s.label);
    expect(await locks()).toEqual(["Qualifying"]);
    await setRound(1, "final");
    await setRound(2, "open");
    const round2 = await weekend();
    expect(round2!.sessions.map((s) => s.label)).toEqual([
      "Practice 1",
      "Sprint Qualifying",
      "Sprint",
      "Qualifying",
      "Race",
    ]);
    expect(await locks()).toEqual(["Sprint Qualifying"]);
    const lock = round2!.sessions.find((s) => s.locksTeam)!;
    expect(round2!.lockSessionId).toBe(lock.id);
  });

  it("a scored session is hidden in its 7 days until it's marked watched", async () => {
    await openGame(db, SEEDED, gameId);
    const round1 = await round2026(db, 1);
    const [qualifying] = await db
      .select({ id: sessions.id, start: sessions.scheduledStart })
      .from(sessions)
      .where(
        and(eq(sessions.eventId, round1.id), eq(sessions.kind, "qualifying")),
      );
    const now = new Date(qualifying!.start.getTime() + 3 * HOUR);
    const userId = await seedUser(db);
    const reader = { userId, spoilerProtection: true };
    const quali = async (r: typeof reader | null) =>
      (await weekend(now, r))!.sessions.find((s) => s.kind === "qualifying")!;

    expect(await quali(reader)).toMatchObject({
      state: "ended",
      counts: true,
      revealed: false,
    });
    // Logged out: the window alone.
    expect((await quali(null)).revealed).toBe(false);
    // Protection off: nothing is hidden.
    expect((await quali({ userId, spoilerProtection: false })).revealed).toBe(
      true,
    );

    await markWatched(db, now, { userId, sessionIds: [qualifying!.id] });
    expect((await quali(reader)).revealed).toBe(true);
    expect((await quali(null)).revealed).toBe(false);
  });

  it("none for a game with no events", async () => {
    expect(
      await weekendFor(db, SEEDED, { gameId: newId(), reader: null }),
    ).toBeNull();
  });
});
