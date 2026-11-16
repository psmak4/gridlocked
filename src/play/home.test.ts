import { and, eq, inArray } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { round2026, seedGame2026 } from "../../tests/helpers/game-2026";
import { createTestDb } from "../../tests/helpers/test-db";
import { seedUser } from "../../tests/helpers/users";
import { profiles, sessions, teamEventTotals } from "@/db/schema";
import type { Db } from "@/db/types";
import { openGame } from "@/game/lineups";
import { createTeam } from "@/game/teams";
import { IdentityError, type Viewer } from "@/identity/viewer";
import { newId } from "@/lib/ids";
import { markWatched } from "@/spoilers/reveal";
import { homeState } from "./home";

const SEEDED = new Date("2026-02-01T09:00:00.000Z");
const DAY = 24 * 3_600_000;

async function viewerOf(db: Db, userId: string): Promise<Viewer> {
  const [profile] = await db
    .select()
    .from(profiles)
    .where(eq(profiles.userId, userId));
  return {
    userId,
    role: "user",
    banned: false,
    username: null,
    displayUsername: null,
    emailVerified: true,
    twoFactorEnabled: false,
    sessionId: newId(),
    impersonatedBy: null,
    staffVerifiedAt: null,
    profile: profile!,
    complete: true,
  };
}

describe("homeState", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: Db;
  let gameId: string;

  beforeEach(async () => {
    t = await createTestDb();
    db = t.db as unknown as Db;
    ({ gameId } = await seedGame2026(db, SEEDED));
    await openGame(db, SEEDED, gameId);
  });

  afterEach(async () => {
    await t.close();
  });

  it("is for someone signed in", async () => {
    await expect(homeState(db, SEEDED, null)).rejects.toBeInstanceOf(
      IdentityError,
    );
  });

  it("no team: no season block", async () => {
    const viewer = await viewerOf(db, await seedUser(db));
    const home = await homeState(db, SEEDED, viewer);
    expect(home).toMatchObject({
      hasGame: true,
      season: null,
      leagues: [],
      timeZone: "UTC",
      now: SEEDED.toISOString(),
    });
    expect(home.weekend!.round).toBe(1);
  });

  it("a team with nothing scored yet has a season block with no figures", async () => {
    const userId = await seedUser(db);
    await createTeam(db, SEEDED, { gameId, userId, name: "Late Brakers" });
    const home = await homeState(db, SEEDED, await viewerOf(db, userId));
    expect(home.season).toEqual({
      teamName: "Late Brakers",
      slot: 1,
      total: null,
      rank: null,
      rankOf: null,
      lastEvent: null,
      hidden: null,
    });
  });

  it("the season total and rank are null while the last race is hidden", async () => {
    const userId = await seedUser(db);
    const teamId = await createTeam(db, SEEDED, {
      gameId,
      userId,
      name: "Late Brakers",
    });
    const round1 = await round2026(db, 1);
    const scored = await db
      .select({
        id: sessions.id,
        kind: sessions.kind,
        start: sessions.scheduledStart,
      })
      .from(sessions)
      .where(
        and(
          eq(sessions.eventId, round1.id),
          inArray(sessions.kind, ["qualifying", "race"]),
        ),
      );
    const race = scored.find((s) => s.kind === "race")!;
    const now = new Date(race.start.getTime() + DAY);
    await db.insert(teamEventTotals).values({
      gameId,
      teamId,
      eventId: round1.id,
      eventSequence: 1,
      points: 114,
      pointsBySession: {},
      cumulativePoints: 114,
      firstReachedSequence: 1,
      globalRank: 1,
      status: "provisional",
      computedAt: now,
    });
    const viewer = await viewerOf(db, userId);

    const hidden = await homeState(db, now, viewer);
    expect(hidden.season).toMatchObject({
      teamName: "Late Brakers",
      total: null,
      rank: null,
      rankOf: null,
      lastEvent: null,
      hidden: { name: expect.stringMatching(/Grand Prix$/) },
    });
    expect([...hidden.season!.hidden!.sessionIds].sort()).toEqual(
      scored.map((s) => s.id).sort(),
    );
    // Nothing hidden reaches the answer.
    expect(JSON.stringify(hidden)).not.toContain("114");

    // Show it: this once, for one session, and the race is still hidden.
    const quali = scored.find((s) => s.kind === "qualifying")!;
    const shown = await homeState(db, now, viewer, { show: [quali.id] });
    expect(shown.season).toMatchObject({
      total: null,
      hidden: { sessionIds: [race.id] },
    });

    await markWatched(db, now, {
      userId,
      sessionIds: scored.map((s) => s.id),
    });
    const watched = await homeState(db, now, viewer);
    expect(watched.season).toMatchObject({
      total: 114,
      rank: 1,
      rankOf: 1,
      lastEvent: 114,
      hidden: null,
    });
  });
});
