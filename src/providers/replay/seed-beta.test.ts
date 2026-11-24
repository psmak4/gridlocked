import { fileURLToPath } from "node:url";
import { and, asc, eq, like } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../../../tests/helpers/test-db";
import {
  assetPrices,
  auditLog,
  events,
  gameEvents,
  games,
  jobs,
  providerRequests,
  results,
  seasons,
  sessions,
  settings,
} from "@/db/schema";
import { tick, type TickDeps } from "@/jobs/tick";
import { newId } from "@/lib/ids";
import { simulatedClockAt } from "@/lib/resolve-clock";
import { setSimulatedClock } from "@/replay/clock-loop";
import { getSetting } from "@/settings";
import { betaOffsetSeconds, ROUND_1_FRIDAY, seedBeta } from "./seed-beta";
import { memoryStore } from "./season-game";

// M9 Task 13: an empty, migrated database becomes the hosted beta's, with the
// replay's clock already running towards round 1.

const FIXTURES = fileURLToPath(
  new URL("../../../tests/fixtures", import.meta.url),
);
/** Two weeks of sign-up before the first beta weekend. */
const REAL_NOW = new Date("2027-02-05T09:30:20Z");
const FIRST_FRIDAY = "2027-02-19";
/** 2027-02-19 is 350 days after 2026-03-06. */
const OFFSET = 350 * 86_400;
const REPLAY_NOW = new Date("2026-02-20T09:30:20Z");
const input = {
  firstFriday: FIRST_FRIDAY,
  fixturesDir: FIXTURES,
  actor: { kind: "admin" as const, label: "owner" },
};

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

describe("betaOffsetSeconds", () => {
  it("puts round 1's Friday on the first beta Friday, in whole days", () => {
    expect(betaOffsetSeconds(REAL_NOW, FIRST_FRIDAY)).toBe(OFFSET);
  });

  it.each([
    ["not a date", "next friday", "expected a date"],
    ["no such day", "2027-02-30", "expected a date"],
    ["a Saturday", "2027-02-20", "is not a Friday"],
    ["today's week, too late to pick a team", "2027-02-05", "at least a day"],
    ["a past Friday", "2027-01-29", "at least a day"],
    // The replay would start before the draft documents are in force.
    ["too far ahead", "2027-06-25", "2026-01-01"],
  ])("refuses %s", (_, firstFriday, message) => {
    expect(() => betaOffsetSeconds(REAL_NOW, firstFriday)).toThrow(message);
  });
});

describe("seedBeta, on an empty database", () => {
  let t: TestDb;
  let gameId: string;
  beforeAll(async () => {
    t = await createTestDb();
    ({ gameId } = await seedBeta(t.db, REAL_NOW, input));
  });
  afterAll(async () => {
    await t.close();
  });

  it("starts the replay's clock, running, at real time minus the offset", async () => {
    expect(await simulatedClockAt(t.db)).toEqual(REPLAY_NOW);
    expect(await getSetting(t.db, "replay_offset")).toEqual({
      mode: "running",
      seconds: OFFSET,
    });
  });

  it("uses the recorded calendar's round 1 Friday", async () => {
    const [first] = await t.db
      .select({ start: sessions.scheduledStart })
      .from(sessions)
      .innerJoin(events, eq(events.id, sessions.eventId))
      .where(eq(events.round, 1))
      .orderBy(asc(sessions.scheduledStart))
      .limit(1);
    expect(first!.start.toISOString().slice(0, 10)).toBe(ROUND_1_FRIDAY);
  });

  it("opens the 2026 game for round 1, with our prices and no results", async () => {
    const [game] = await t.db.select().from(games);
    expect(game).toMatchObject({ id: gameId, status: "open" });
    const statuses = await t.db
      .select({ round: events.round, status: gameEvents.status })
      .from(gameEvents)
      .innerJoin(events, eq(events.id, gameEvents.eventId))
      .orderBy(asc(events.round));
    expect(statuses).toHaveLength(23);
    expect(statuses[0]!.status).toBe("open");
    expect(new Set(statuses.slice(1).map((s) => s.status))).toEqual(
      new Set(["upcoming"]),
    );
    // 22 drivers and 11 constructors.
    expect(await t.db.select().from(assetPrices)).toHaveLength(33);
    expect(await t.db.select().from(results)).toEqual([]);
    expect(await t.db.select().from(providerRequests)).toEqual([]);
  });

  it("queues round 1's lock, every event's polls and a calendar sync due now", async () => {
    const sync = await t.db
      .select()
      .from(jobs)
      .where(eq(jobs.kind, "sync_calendar"));
    expect(sync).toHaveLength(1);
    expect(sync[0]).toMatchObject({ status: "pending", runAt: REPLAY_NOW });
    const locks = await t.db
      .select()
      .from(jobs)
      .where(eq(jobs.kind, "game_lock"));
    expect(locks).toHaveLength(23);
    const polls = await t.db
      .select()
      .from(jobs)
      .where(like(jobs.dedupeKey, "poll:%:start"));
    expect(polls.length).toBeGreaterThanOrEqual(46);
    // Nothing but the sync is due before the season starts.
    const due = (await t.db.select().from(jobs)).filter(
      (j) => j.runAt.getTime() <= REPLAY_NOW.getTime(),
    );
    expect(due.map((j) => j.kind)).toEqual(["sync_calendar"]);
  });

  it("audits the clock's start with who ran it", async () => {
    const [row] = await t.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, "setting.update"),
          eq(auditLog.actorLabel, "owner"),
        ),
      );
    expect(row).toMatchObject({
      reason: "The closed beta is seeded",
      after: { mode: "running", seconds: OFFSET },
    });
  });

  it("the hosted tick's first wakes publish the file, then run the sync", async () => {
    const ran: string[] = [];
    const deps: TickDeps = {
      db: () => t.db,
      store: memoryStore(),
      mode: "replay",
      hostedReplay: true,
      handlers: () => ({
        sync_calendar: async (job) => {
          ran.push(job.kind);
        },
      }),
    };
    const at = (minutes: number) =>
      new Date(REAL_NOW.getTime() + minutes * 60_000);
    expect(await tick(deps, at(1))).toMatchObject({
      action: "republished",
      file: { replay: { seconds: OFFSET } },
    });
    expect(await tick(deps, at(2))).toMatchObject({ action: "wake" });
    expect(ran).toEqual(["sync_calendar"]);
    expect(await tick(deps, at(3))).toEqual({ action: "sleep" });
  });

  it("refuses to run again", async () => {
    await expect(seedBeta(t.db, REAL_NOW, input)).rejects.toThrow("not empty");
    expect(await t.db.select().from(games)).toHaveLength(1);
  });
});

describe("seedBeta refuses", () => {
  let t: TestDb;
  afterEach(async () => {
    await t.close();
  });

  it.each<[string, (db: TestDb["db"]) => Promise<unknown>, string]>([
    [
      "a season",
      (db) =>
        db
          .insert(seasons)
          .values({ id: newId(), year: 2026, status: "active" }),
      "seasons",
    ],
    [
      "polled data",
      (db) =>
        db.insert(providerRequests).values({
          id: newId(),
          provider: "jolpica",
          endpoint: "races",
          params: {},
          requestedAt: REAL_NOW,
          statusCode: 200,
          durationMs: 10,
          outcome: "new_snapshot",
        }),
      "provider_requests",
    ],
    ["a clock of its own", (db) => setSimulatedClock(db, REPLAY_NOW), "clock"],
  ])("a database with %s, and writes nothing", async (_, fill, named) => {
    t = await createTestDb();
    await fill(t.db);
    const before = await t.db.select().from(settings);
    await expect(seedBeta(t.db, REAL_NOW, input)).rejects.toThrow(named);
    expect(await t.db.select().from(settings)).toEqual(before);
    expect(await t.db.select().from(games)).toEqual([]);
  });

  it("a half-made seed: a failure leaves the database empty", async () => {
    t = await createTestDb();
    await expect(
      seedBeta(t.db, REAL_NOW, { ...input, fixturesDir: "/nonexistent" }),
    ).rejects.toThrow();
    expect(await simulatedClockAt(t.db)).toBeNull();
    expect(await t.db.select().from(seasons)).toEqual([]);
    // So it can simply be run again.
    await expect(seedBeta(t.db, REAL_NOW, input)).resolves.toBeDefined();
  });

  it("an account already signed up", async () => {
    t = await createTestDb();
    const { users } = await import("@/db/schema");
    const [system] = await t.db.select().from(users);
    await t.db.insert(users).values({
      ...system!,
      id: newId(),
      email: "tester@example.test",
      username: "tester",
      displayUsername: "tester",
      role: "user",
    });
    await expect(seedBeta(t.db, REAL_NOW, input)).rejects.toThrow("users");
  });
});
