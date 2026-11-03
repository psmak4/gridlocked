import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import { newId } from "@/lib/ids";
import { setSimulatedClock } from "@/replay/clock-loop";
import {
  assetPrices,
  chipPlays,
  circuits,
  constructors,
  drivers,
  events,
  gameEvents,
  games,
  lineupPicks,
  lineupVersions,
  poolAssets,
  rulesetVersions,
  scoringRules,
  seasons,
  sessionResultState,
  sessions,
  teams,
} from "./schema";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

/** As in results.test.ts: the SQLSTATE is on the error or its cause. */
async function expectPgError(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, "expected the statement to be rejected").toBeDefined();
  const direct = (error as { code?: string }).code;
  const cause = (error as { cause?: { code?: string } }).cause?.code;
  expect(direct ?? cause).toBe(code);
}

const RESTRICT_VIOLATION = "23001";
const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
// Lineup refusals carry their own SQLSTATEs, so the game layer can map them.
const WINDOW_CLOSED = "GL001";
const COMPOSITION = "GL002";
const ASSET_UNAVAILABLE = "GL003";
const OVER_BUDGET = "GL004";
const CHIP_UNAVAILABLE = "GL006";
const CHIP_WINDOW_CLOSED = "GL007";
const NOW = new Date("2026-03-01T00:00:00Z");

describe("the ruleset freeze (DM 3.2)", () => {
  let t: TestDb;
  let gameId: string;
  let eventId: string;
  let versionId: string;
  let ruleId: string;

  beforeEach(async () => {
    t = await createTestDb();
    const seasonId = newId();
    await t.db
      .insert(seasons)
      .values({ id: seasonId, year: 2026, status: "active" });
    const circuitId = newId();
    await t.db.insert(circuits).values({
      id: circuitId,
      slug: "melbourne",
      name: "Albert Park",
      locality: "Melbourne",
      country: "Australia",
      latitude: "-37.849700",
      longitude: "144.968000",
      timezone: "Australia/Melbourne",
    });
    eventId = newId();
    await t.db.insert(events).values({
      id: eventId,
      seasonId,
      round: 1,
      slug: "2026-australia",
      name: "Australian Grand Prix",
      circuitId,
      format: "standard",
      status: "scheduled",
      lockAt: NOW,
      lockAtSource: "default",
    });
    gameId = newId();
    await t.db.insert(games).values({
      id: gameId,
      seasonId,
      gameType: "season_fantasy",
      slug: "2026-fantasy",
      name: "2026 Fantasy",
      status: "setup",
    });
    versionId = newId();
    await t.db.insert(rulesetVersions).values({
      id: versionId,
      gameId,
      version: 1,
      effectiveFromEventId: eventId,
      params: { any: "thing" },
      notes: "v1",
      publishedAt: NOW,
    });
    await t.db.insert(gameEvents).values({
      gameId,
      eventId,
      sequence: 1,
      status: "upcoming",
      rulesetVersionId: versionId,
    });
    ruleId = await insertRule("race.finish_position");
  });
  afterEach(async () => {
    await t.close();
  });

  async function insertRule(code: string) {
    const id = newId();
    await t.db.insert(scoringRules).values({
      id,
      rulesetVersionId: versionId,
      code,
      sessionKind: "race",
      target: "driver",
      kind: "position_table",
      category: "race",
      params: {},
      sortOrder: 1,
    });
    return id;
  }

  const setEventStatus = (status: "open" | "locked" | "scored" | "final") =>
    t.db
      .update(gameEvents)
      .set({ status })
      .where(eq(gameEvents.eventId, eventId));

  it("a ruleset version can be edited while no event using it has locked", async () => {
    await setEventStatus("open");
    await t.db
      .update(rulesetVersions)
      .set({ notes: "edited" })
      .where(eq(rulesetVersions.id, versionId));
    await t.db
      .update(scoringRules)
      .set({ sortOrder: 2 })
      .where(eq(scoringRules.id, ruleId));
    await insertRule("race.fastest_lap");
    await t.db.delete(scoringRules).where(eq(scoringRules.id, ruleId));
    const [version] = await t.db.select().from(rulesetVersions);
    expect(version!.notes).toBe("edited");
  });

  it.each(["locked", "scored", "final"] as const)(
    "updating a version used by a %s event raises",
    async (status) => {
      await setEventStatus(status);
      await expectPgError(
        t.db
          .update(rulesetVersions)
          .set({ notes: "edited" })
          .where(eq(rulesetVersions.id, versionId)),
        RESTRICT_VIOLATION,
      );
      await expectPgError(
        t.db.delete(rulesetVersions).where(eq(rulesetVersions.id, versionId)),
        RESTRICT_VIOLATION,
      );
    },
  );

  it("inserting a scoring rule into such a version raises", async () => {
    await setEventStatus("locked");
    await expectPgError(insertRule("race.fastest_lap"), RESTRICT_VIOLATION);
    await expectPgError(
      t.db
        .update(scoringRules)
        .set({ sortOrder: 2 })
        .where(eq(scoringRules.id, ruleId)),
      RESTRICT_VIOLATION,
    );
    await expectPgError(
      t.db.delete(scoringRules).where(eq(scoringRules.id, ruleId)),
      RESTRICT_VIOLATION,
    );
  });

  it("a locked event elsewhere does not freeze another version", async () => {
    const otherId = newId();
    await t.db.insert(rulesetVersions).values({
      id: otherId,
      gameId,
      version: 2,
      effectiveFromEventId: eventId,
      params: {},
      notes: "v2",
      publishedAt: NOW,
    });
    await setEventStatus("locked");
    await t.db
      .update(rulesetVersions)
      .set({ notes: "edited" })
      .where(eq(rulesetVersions.id, otherId));
  });

  it("a version number is unique within a game, and rule codes within a version", async () => {
    await expectPgError(
      t.db.insert(rulesetVersions).values({
        id: newId(),
        gameId,
        version: 1,
        effectiveFromEventId: eventId,
        params: {},
        notes: "dup",
        publishedAt: NOW,
      }),
      UNIQUE_VIOLATION,
    );
    await expectPgError(insertRule("race.finish_position"), UNIQUE_VIOLATION);
  });

  it("a scoring rule's kind must be one of the seven", async () => {
    await expectPgError(
      t.db.insert(scoringRules).values({
        id: newId(),
        rulesetVersionId: versionId,
        code: "race.odd",
        sessionKind: "race",
        target: "driver",
        kind: "made_up" as never,
        category: "race",
        params: {},
        sortOrder: 1,
      }),
      CHECK_VIOLATION,
    );
  });
});

describe("pool assets and prices (DM 3.4, 3.5)", () => {
  let t: TestDb;
  let eventId: string;
  let assetId: string;

  beforeEach(async () => {
    t = await createTestDb();
    const seasonId = newId();
    await t.db
      .insert(seasons)
      .values({ id: seasonId, year: 2026, status: "active" });
    const circuitId = newId();
    await t.db.insert(circuits).values({
      id: circuitId,
      slug: "melbourne",
      name: "Albert Park",
      locality: "Melbourne",
      country: "Australia",
      latitude: "-37.849700",
      longitude: "144.968000",
      timezone: "Australia/Melbourne",
    });
    eventId = newId();
    await t.db.insert(events).values({
      id: eventId,
      seasonId,
      round: 1,
      slug: "2026-australia",
      name: "Australian Grand Prix",
      circuitId,
      format: "standard",
      status: "scheduled",
      lockAt: NOW,
      lockAtSource: "default",
    });
    const gameId = newId();
    await t.db.insert(games).values({
      id: gameId,
      seasonId,
      gameType: "season_fantasy",
      slug: "2026-fantasy",
      name: "2026 Fantasy",
      status: "setup",
    });
    const versionId = newId();
    await t.db.insert(rulesetVersions).values({
      id: versionId,
      gameId,
      version: 1,
      effectiveFromEventId: eventId,
      params: {},
      notes: "v1",
      publishedAt: NOW,
    });
    await t.db.insert(gameEvents).values({
      gameId,
      eventId,
      sequence: 1,
      status: "upcoming",
      rulesetVersionId: versionId,
    });
    const driverId = newId();
    await t.db.insert(drivers).values({
      id: driverId,
      slug: "norris",
      givenName: "Lando",
      familyName: "Norris",
      nationality: "British",
    });
    assetId = newId();
    await t.db.insert(poolAssets).values({
      id: assetId,
      gameId,
      assetType: "driver",
      driverId,
      status: "active",
      addedFromEventId: eventId,
    });
    await t.db
      .insert(assetPrices)
      .values({ assetId, eventId, price: 280, source: "initial" });
  });
  afterEach(async () => {
    await t.close();
  });

  const setEventStatus = (status: "upcoming" | "open" | "locked") =>
    t.db
      .update(gameEvents)
      .set({ status })
      .where(eq(gameEvents.eventId, eventId));
  const where = () => eq(assetPrices.assetId, assetId);

  it("a price can change until its event opens", async () => {
    await setEventStatus("upcoming");
    await t.db.update(assetPrices).set({ price: 290 }).where(where());
    const [row] = await t.db.select().from(assetPrices);
    expect(row!.price).toBe(290);
  });

  it("a price of an open event can't be changed or removed", async () => {
    await setEventStatus("open");
    await expectPgError(
      t.db.update(assetPrices).set({ price: 290 }).where(where()),
      RESTRICT_VIOLATION,
    );
    await expectPgError(
      t.db.delete(assetPrices).where(where()),
      RESTRICT_VIOLATION,
    );
  });

  it("a price of a locked event can't be changed or removed", async () => {
    await setEventStatus("locked");
    await expectPgError(
      t.db.update(assetPrices).set({ price: 290 }).where(where()),
      RESTRICT_VIOLATION,
    );
    await expectPgError(
      t.db.delete(assetPrices).where(where()),
      RESTRICT_VIOLATION,
    );
  });

  it("a price can't be added to a locked event", async () => {
    const otherId = newId();
    await t.db.insert(poolAssets).values({
      id: otherId,
      gameId: (await t.db.select().from(games))[0]!.id,
      assetType: "constructor",
      constructorId: (
        await t.db
          .insert(constructors)
          .values({
            id: newId(),
            slug: "mclaren",
            name: "McLaren",
            nationality: "British",
          })
          .returning({ id: constructors.id })
      )[0]!.id,
      status: "active",
      addedFromEventId: eventId,
    });
    await setEventStatus("locked");
    await expectPgError(
      t.db
        .insert(assetPrices)
        .values({ assetId: otherId, eventId, price: 300, source: "carried" }),
      RESTRICT_VIOLATION,
    );
  });

  it("an asset is in a game once", async () => {
    const [asset] = await t.db.select().from(poolAssets);
    await expectPgError(
      t.db.insert(poolAssets).values({ ...asset!, id: newId() }),
      UNIQUE_VIOLATION,
    );
  });

  it("a price source must be one of the four", async () => {
    await expectPgError(
      t.db
        .update(assetPrices)
        .set({ source: "guess" as never })
        .where(where()),
      CHECK_VIOLATION,
    );
  });
});

describe("teams (DM 3.6)", () => {
  let t: TestDb;
  let seasonId: string;
  let eventId: string;
  let gameId: string;
  const userId = newId();

  beforeEach(async () => {
    t = await createTestDb();
    seasonId = newId();
    await t.db
      .insert(seasons)
      .values({ id: seasonId, year: 2026, status: "active" });
    const circuitId = newId();
    await t.db.insert(circuits).values({
      id: circuitId,
      slug: "melbourne",
      name: "Albert Park",
      locality: "Melbourne",
      country: "Australia",
      latitude: "-37.849700",
      longitude: "144.968000",
      timezone: "Australia/Melbourne",
    });
    eventId = newId();
    await t.db.insert(events).values({
      id: eventId,
      seasonId,
      round: 1,
      slug: "2026-australia",
      name: "Australian Grand Prix",
      circuitId,
      format: "standard",
      status: "scheduled",
      lockAt: NOW,
      lockAtSource: "default",
    });
    gameId = newId();
    await t.db.insert(games).values({
      id: gameId,
      seasonId,
      gameType: "season_fantasy",
      slug: "2026-fantasy",
      name: "2026 Fantasy",
      status: "open",
    });
    await addVersion(1, 3);
  });
  afterEach(async () => {
    await t.close();
  });

  const addVersion = (version: number, teamsPerUser: number) =>
    t.db.insert(rulesetVersions).values({
      id: newId(),
      gameId,
      version,
      effectiveFromEventId: eventId,
      params: { teamsPerUser },
      notes: `v${version}`,
      publishedAt: NOW,
    });
  const teamRow = (slot: number, name = `Team ${slot}`) => ({
    id: newId(),
    gameId,
    userId,
    slot,
    name,
    status: "active" as const,
  });

  it("slots 1 to 3 are accepted", async () => {
    await t.db.insert(teams).values([1, 2, 3].map((slot) => teamRow(slot)));
    expect(await t.db.select().from(teams)).toHaveLength(3);
  });

  it("slot 4 is refused by the database", async () => {
    await expectPgError(t.db.insert(teams).values(teamRow(4)), CHECK_VIOLATION);
    await expectPgError(t.db.insert(teams).values(teamRow(0)), CHECK_VIOLATION);
  });

  it("the limit is the latest version's teamsPerUser", async () => {
    await addVersion(2, 2);
    await t.db.insert(teams).values(teamRow(2));
    await expectPgError(t.db.insert(teams).values(teamRow(3)), CHECK_VIOLATION);
  });

  it("a slot is a user's once per game", async () => {
    await t.db.insert(teams).values(teamRow(1));
    await expectPgError(
      t.db.insert(teams).values(teamRow(1, "Other")),
      UNIQUE_VIOLATION,
    );
  });

  it("two creates for the same slot can't both succeed", async () => {
    const attempt = () =>
      t.db.transaction(async (tx) => {
        await tx.insert(teams).values(teamRow(3));
      });
    const results = await Promise.allSettled([attempt(), attempt()]);
    expect(results.map((r) => r.status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(await t.db.select().from(teams)).toHaveLength(1);
  });

  it("a name must be 1 to 30 characters, and a status active or retired", async () => {
    await expectPgError(
      t.db.insert(teams).values(teamRow(1, "")),
      CHECK_VIOLATION,
    );
    await expectPgError(
      t.db.insert(teams).values(teamRow(1, "x".repeat(31))),
      CHECK_VIOLATION,
    );
    await t.db.insert(teams).values(teamRow(1));
    await expectPgError(
      t.db
        .update(teams)
        .set({ status: "gone" as never })
        .where(eq(teams.userId, userId)),
      CHECK_VIOLATION,
    );
  });
});

describe("lineup versions (DM 3.7)", () => {
  let t: TestDb;
  let eventId: string;
  let gameEventId: string;
  let gameId: string;
  let teamId: string;
  let driverAsset: string;
  let constructorAsset: string;
  const LOCK = new Date("2026-03-01T06:00:00Z");
  const CLOCK = new Date("2026-02-28T12:00:00Z");

  beforeEach(async () => {
    t = await createTestDb();
    const seasonId = newId();
    await t.db
      .insert(seasons)
      .values({ id: seasonId, year: 2026, status: "active" });
    const circuitId = newId();
    await t.db.insert(circuits).values({
      id: circuitId,
      slug: "melbourne",
      name: "Albert Park",
      locality: "Melbourne",
      country: "Australia",
      latitude: "-37.849700",
      longitude: "144.968000",
      timezone: "Australia/Melbourne",
    });
    const event = (round: number, slug: string) => ({
      id: newId(),
      seasonId,
      round,
      slug,
      name: slug,
      circuitId,
      format: "standard" as const,
      status: "scheduled" as const,
      lockAt: new Date(LOCK.getTime() + round * 86_400_000),
      lockAtSource: "default" as const,
    });
    const round1 = { ...event(1, "2026-australia"), lockAt: LOCK };
    const round2 = event(2, "2026-china");
    eventId = round1.id;
    gameEventId = round2.id;
    await t.db.insert(events).values([round1, round2]);
    gameId = newId();
    await t.db.insert(games).values({
      id: gameId,
      seasonId,
      gameType: "season_fantasy",
      slug: "2026-fantasy",
      name: "2026 Fantasy",
      status: "open",
    });
    const versionId = newId();
    await t.db.insert(rulesetVersions).values({
      id: versionId,
      gameId,
      version: 1,
      effectiveFromEventId: eventId,
      params: {
        squad: { drivers: 1, constructors: 1, boosts: 1 },
        teamsPerUser: 3,
        budget: 100,
        // Playable from the start here, so a first event can use them.
        chips: [
          {
            code: "chip_limitless",
            name: "Blank Cheque",
            unlock: "from_start",
            effect: "limitless",
          },
        ],
      },
      notes: "v1",
      publishedAt: NOW,
    });
    await t.db.insert(gameEvents).values({
      gameId,
      eventId,
      sequence: 1,
      status: "open",
      rulesetVersionId: versionId,
    });
    const driverId = newId();
    await t.db.insert(drivers).values({
      id: driverId,
      slug: "norris",
      givenName: "Lando",
      familyName: "Norris",
      nationality: "British",
    });
    const constructorId = newId();
    await t.db.insert(constructors).values({
      id: constructorId,
      slug: "mclaren",
      name: "McLaren",
      nationality: "British",
    });
    driverAsset = newId();
    constructorAsset = newId();
    await t.db.insert(poolAssets).values([
      {
        id: driverAsset,
        gameId,
        assetType: "driver",
        driverId,
        status: "active",
        addedFromEventId: eventId,
      },
      {
        id: constructorAsset,
        gameId,
        assetType: "constructor",
        constructorId,
        status: "active",
        addedFromEventId: eventId,
      },
    ]);
    // 50 + 40: within the budget of 100.
    await t.db.insert(assetPrices).values([
      { assetId: driverAsset, eventId, price: 50, source: "initial" },
      { assetId: constructorAsset, eventId, price: 40, source: "initial" },
    ]);
    teamId = newId();
    await t.db.insert(teams).values({
      id: teamId,
      gameId,
      userId: newId(),
      slot: 1,
      name: "One",
      status: "active",
    });
    await setSimulatedClock(t.db, CLOCK);
  });
  afterEach(async () => {
    await t.close();
  });

  /** One version with its picks, committed together (the check is deferred). */
  const saveVersion = (
    over: Partial<typeof lineupVersions.$inferInsert> = {},
    picks = [
      { assetId: driverAsset, isBoost: true },
      { assetId: constructorAsset, isBoost: false },
    ],
  ) => {
    const id = newId();
    return t.db.transaction(async (tx) => {
      await tx
        .insert(lineupVersions)
        .values({ id, teamId, forEventId: eventId, kind: "regular", ...over });
      if (picks.length > 0) {
        await tx
          .insert(lineupPicks)
          .values(picks.map((p) => ({ lineupVersionId: id, ...p })));
      }
      return id;
    });
  };

  it("a version for an event that isn't open is refused", async () => {
    await t.db
      .update(gameEvents)
      .set({ status: "upcoming" })
      .where(eq(gameEvents.eventId, eventId));
    await expectPgError(saveVersion(), WINDOW_CLOSED);
    await t.db
      .update(gameEvents)
      .set({ status: "locked" })
      .where(eq(gameEvents.eventId, eventId));
    await expectPgError(saveVersion(), WINDOW_CLOSED);
    // An event the game doesn't have is not open for it either.
    await expectPgError(
      saveVersion({ forEventId: gameEventId }),
      WINDOW_CLOSED,
    );
    expect(await t.db.select().from(lineupVersions)).toHaveLength(0);
  });

  it("a version for an open event before lock is accepted", async () => {
    await saveVersion();
    expect(await t.db.select().from(lineupVersions)).toHaveLength(1);
  });

  it("saved_at comes from app_now(), not from the insert", async () => {
    await saveVersion({ savedAt: new Date("2020-01-01T00:00:00Z") });
    const [row] = await t.db.select().from(lineupVersions);
    expect(row!.savedAt).toEqual(CLOCK);
    await setSimulatedClock(t.db, new Date(CLOCK.getTime() + 60_000));
    await saveVersion({ savedAt: new Date("2020-01-01T00:00:00Z") });
    const later = await t.db.select().from(lineupVersions);
    expect(later.map((r) => r.savedAt.getTime()).sort()).toEqual([
      CLOCK.getTime(),
      CLOCK.getTime() + 60_000,
    ]);
  });

  it("a version is refused at lock_at, even when the clock passes it between the insert and the commit", async () => {
    await setSimulatedClock(t.db, LOCK);
    await expectPgError(saveVersion(), WINDOW_CLOSED);
    await setSimulatedClock(t.db, new Date(LOCK.getTime() - 1000));
    await saveVersion();
    // Inserted before the lock, but the clock passes it before the commit.
    const error = await t.db
      .transaction(async (tx) => {
        const id = newId();
        await tx
          .insert(lineupVersions)
          .values({ id, teamId, forEventId: eventId, kind: "regular" });
        await tx.insert(lineupPicks).values([
          { lineupVersionId: id, assetId: driverAsset, isBoost: true },
          { lineupVersionId: id, assetId: constructorAsset, isBoost: false },
        ]);
        await setSimulatedClock(tx, LOCK);
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(error).toBeDefined();
    expect(await t.db.select().from(lineupVersions)).toHaveLength(1);
  });

  it("the squad comes from the ruleset params, and a Boost must be on a driver", async () => {
    await expectPgError(saveVersion({}, []), COMPOSITION);
    await expectPgError(
      saveVersion({}, [{ assetId: driverAsset, isBoost: true }]),
      COMPOSITION,
    );
    await expectPgError(
      saveVersion({}, [
        { assetId: driverAsset, isBoost: false },
        { assetId: constructorAsset, isBoost: true },
      ]),
      COMPOSITION,
    );
    await expectPgError(
      saveVersion({}, [
        { assetId: driverAsset, isBoost: true },
        { assetId: constructorAsset, isBoost: true },
      ]),
      COMPOSITION,
    );
    expect(await t.db.select().from(lineupVersions)).toHaveLength(0);
  });

  it("an asset withdrawn at or before the event can't be picked", async () => {
    await t.db
      .update(poolAssets)
      .set({ status: "withdrawn", withdrawnFromEventId: eventId })
      .where(eq(poolAssets.id, constructorAsset));
    await expectPgError(saveVersion(), ASSET_UNAVAILABLE);
    expect(await t.db.select().from(lineupVersions)).toHaveLength(0);
  });

  /** Prices are fixed once an event is open: reprice it while upcoming. */
  const repriceDriver = async (price: number) => {
    const event = eq(gameEvents.eventId, eventId);
    await t.db.update(gameEvents).set({ status: "upcoming" }).where(event);
    await t.db
      .update(assetPrices)
      .set({ price })
      .where(eq(assetPrices.assetId, driverAsset));
    await t.db.update(gameEvents).set({ status: "open" }).where(event);
  };

  it("a lineup over the team's purchasing power is refused, unless it is limitless", async () => {
    await repriceDriver(70);
    // 70 + 40 against a first event's budget of 100.
    await expectPgError(saveVersion(), OVER_BUDGET);
    expect(await t.db.select().from(lineupVersions)).toHaveLength(0);
    // A limitless version needs Blank Cheque played for the event.
    await expectPgError(saveVersion({ kind: "limitless" }), CHIP_UNAVAILABLE);
    await t.db.insert(chipPlays).values({
      id: newId(),
      teamId,
      gameId,
      chipCode: "chip_limitless",
      eventId,
      status: "played",
    });
    await saveVersion({ kind: "limitless" });
    expect(await t.db.select().from(lineupVersions)).toHaveLength(1);
    // 60 + 40 is exactly the budget.
    await repriceDriver(60);
    await saveVersion();
    expect(await t.db.select().from(lineupVersions)).toHaveLength(2);
  });

  it("an asset with no price at the event can't be saved", async () => {
    const event = eq(gameEvents.eventId, eventId);
    await t.db.update(gameEvents).set({ status: "upcoming" }).where(event);
    await t.db
      .delete(assetPrices)
      .where(eq(assetPrices.assetId, constructorAsset));
    await t.db.update(gameEvents).set({ status: "open" }).where(event);
    await expectPgError(saveVersion(), CHECK_VIOLATION);
    expect(await t.db.select().from(lineupVersions)).toHaveLength(0);
  });

  it("picks can't be added to or removed from a version after the lock", async () => {
    const id = await saveVersion();
    await setSimulatedClock(t.db, LOCK);
    await expectPgError(
      t.db.delete(lineupPicks).where(eq(lineupPicks.lineupVersionId, id)),
      WINDOW_CLOSED,
    );
    await expectPgError(
      t.db
        .update(lineupPicks)
        .set({ isBoost: false })
        .where(eq(lineupPicks.assetId, driverAsset)),
      WINDOW_CLOSED,
    );
    expect(await t.db.select().from(lineupPicks)).toHaveLength(2);
  });

  it("a saved version's own columns can't be rewritten", async () => {
    const id = await saveVersion();
    for (const change of [
      { savedAt: new Date("2020-01-01T00:00:00Z") },
      { forEventId: gameEventId },
      { kind: "limitless" as const },
      { teamId: newId() },
    ]) {
      await expectPgError(
        t.db
          .update(lineupVersions)
          .set(change)
          .where(eq(lineupVersions.id, id)),
        RESTRICT_VIOLATION,
      );
    }
  });

  it("a lineup_picks asset can only be picked once per version", async () => {
    await expectPgError(
      saveVersion({}, [
        { assetId: driverAsset, isBoost: true },
        { assetId: driverAsset, isBoost: false },
      ]),
      UNIQUE_VIOLATION,
    );
  });

  it("a version's kind must be one of the three, and final_fix needs a session", async () => {
    await expectPgError(
      saveVersion({ kind: "other" as never }),
      CHECK_VIOLATION,
    );
    await expectPgError(saveVersion({ kind: "final_fix" }), CHECK_VIOLATION);
  });

  it("a lock_at can't be moved to a time already past", async () => {
    const move = (lockAt: Date, id = eventId) =>
      t.db.update(events).set({ lockAt }).where(eq(events.id, id));
    // The clock is CLOCK. At or before it is refused; a future time is fine.
    await expectPgError(move(CLOCK), RESTRICT_VIOLATION);
    await expectPgError(
      move(new Date(CLOCK.getTime() - 3_600_000)),
      RESTRICT_VIOLATION,
    );
    await move(new Date(CLOCK.getTime() + 3_600_000));
    const [row] = await t.db
      .select()
      .from(events)
      .where(eq(events.id, eventId));
    expect(row!.lockAt).toEqual(new Date(CLOCK.getTime() + 3_600_000));
  });

  it("a lock that has passed can't be moved later", async () => {
    await setSimulatedClock(t.db, new Date(LOCK.getTime() + 60_000));
    await expectPgError(
      t.db
        .update(events)
        .set({ lockAt: new Date(LOCK.getTime() + 3_600_000) })
        .where(eq(events.id, eventId)),
      RESTRICT_VIOLATION,
    );
    const [row] = await t.db
      .select()
      .from(events)
      .where(eq(events.id, eventId));
    expect(row!.lockAt).toEqual(LOCK);
  });

  it("with no simulated clock the window uses the time at the commit, not the transaction's start", async () => {
    const lockIn = async (ms: number) => {
      // Moved while the simulated clock is still set, then the clock is
      // dropped, as in production.
      await t.db.execute(
        sql`update events set lock_at = clock_timestamp() + ${`${ms} milliseconds`}::interval where id = ${eventId}`,
      );
    };
    await lockIn(60_000);
    await t.db.execute(sql`delete from settings where key = 'simulated_clock'`);
    await saveVersion();
    expect(await t.db.select().from(lineupVersions)).toHaveLength(1);

    await t.db.delete(lineupVersions);
    await t.db.execute(
      sql`insert into settings (key, value) values ('simulated_clock', '{"at": "2026-02-28T12:00:00Z"}')`,
    );
    await lockIn(250);
    await t.db.execute(sql`delete from settings where key = 'simulated_clock'`);
    // now() is the start of the transaction, before the lock; by the commit the
    // lock has passed.
    const error = await t.db
      .transaction(async (tx) => {
        const id = newId();
        await tx
          .insert(lineupVersions)
          .values({ id, teamId, forEventId: eventId, kind: "regular" });
        await tx.insert(lineupPicks).values([
          { lineupVersionId: id, assetId: driverAsset, isBoost: true },
          { lineupVersionId: id, assetId: constructorAsset, isBoost: false },
        ]);
        const { rows } = await tx.execute(
          sql`select (now() < (select lock_at from events where id = ${eventId})) as early`,
        );
        expect((rows[0] as { early: boolean }).early).toBe(true);
        await tx.execute(sql`select pg_sleep(0.4)`);
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(
      (error as { cause?: { code?: string } }).cause?.code ??
        (error as { code?: string }).code,
    ).toBe(WINDOW_CLOSED);
    expect(await t.db.select().from(lineupVersions)).toHaveLength(0);
  });

  it("an event with no game row can have its lock_at moved freely", async () => {
    await t.db.delete(gameEvents);
    await t.db
      .update(events)
      .set({ lockAt: new Date(CLOCK.getTime() - 3_600_000) })
      .where(eq(events.id, eventId));
    const [row] = await t.db
      .select()
      .from(events)
      .where(eq(events.id, eventId));
    expect(row!.lockAt).toEqual(new Date(CLOCK.getTime() - 3_600_000));
  });

  it("a final_fix version outside its window is refused by the database", async () => {
    // Qualifying at the lock, the race a day later.
    const session = (kind: "qualifying" | "race", start: Date) => ({
      id: newId(),
      eventId,
      kind,
      scheduledStart: start,
      startConfirmed: true,
      scheduledEnd: new Date(start.getTime() + 3_600_000),
      timeSource: "provider" as const,
      status: "scheduled" as const,
    });
    const qualifying = session("qualifying", LOCK);
    const race = session("race", new Date(LOCK.getTime() + 86_400_000));
    await t.db.insert(sessions).values([qualifying, race]);
    const finalFix = () =>
      saveVersion({ kind: "final_fix", effectiveFromSessionId: race.id });
    const inTime = new Date(race.scheduledStart.getTime() - 3_600_000);

    // The event hasn't locked.
    await setSimulatedClock(t.db, inTime);
    await t.db
      .insert(sessionResultState)
      .values({ sessionId: qualifying.id, status: "provisional" });
    await expectPgError(finalFix(), CHIP_WINDOW_CLOSED);
    await t.db
      .update(gameEvents)
      .set({ status: "locked" })
      .where(eq(gameEvents.eventId, eventId));
    // Qualifying's results aren't in.
    await t.db
      .update(sessionResultState)
      .set({ status: "awaiting" })
      .where(eq(sessionResultState.sessionId, qualifying.id));
    await expectPgError(finalFix(), CHIP_WINDOW_CLOSED);
    // The race has started.
    await t.db
      .update(sessionResultState)
      .set({ status: "provisional" })
      .where(eq(sessionResultState.sessionId, qualifying.id));
    await setSimulatedClock(t.db, race.scheduledStart);
    await expectPgError(finalFix(), CHIP_WINDOW_CLOSED);
    // In the window, but with no Late Call played.
    await setSimulatedClock(t.db, inTime);
    await expectPgError(finalFix(), CHIP_UNAVAILABLE);
    expect(await t.db.select().from(lineupVersions)).toHaveLength(0);
  });

  it("rewriting a lock_at that has passed to the same value is left alone", async () => {
    await setSimulatedClock(t.db, new Date(LOCK.getTime() + 60_000));
    await t.db
      .update(events)
      .set({ lockAt: LOCK, name: "Renamed" })
      .where(eq(events.id, eventId));
  });
});
