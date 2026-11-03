import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import { newId } from "@/lib/ids";
import {
  assetPrices,
  circuits,
  constructors,
  drivers,
  events,
  gameEvents,
  games,
  poolAssets,
  rulesetVersions,
  scoringRules,
  seasons,
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

  const setEventStatus = (status: "open" | "locked") =>
    t.db
      .update(gameEvents)
      .set({ status })
      .where(eq(gameEvents.eventId, eventId));
  const where = () => eq(assetPrices.assetId, assetId);

  it("a price can change until its event locks", async () => {
    await setEventStatus("open");
    await t.db.update(assetPrices).set({ price: 290 }).where(where());
    const [row] = await t.db.select().from(assetPrices);
    expect(row!.price).toBe(290);
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
