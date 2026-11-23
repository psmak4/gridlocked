import { readFileSync } from "node:fs";
import { and, count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { categoryId, seedViewer } from "../../tests/helpers/community";
import {
  lockRound,
  round2026,
  seedGame2026,
} from "../../tests/helpers/game-2026";
import {
  idFor,
  ingest,
  seedEntriesFor,
  seedWorldWithSeats,
} from "../../tests/helpers/ingest-2026";
import { sessionOf } from "../../tests/helpers/pipeline-2026";
import { loadBody, sessionIdFor } from "../../tests/helpers/results-2026";
import { createTestDb } from "../../tests/helpers/test-db";
import {
  auditLog,
  modQueueItems,
  poolAssets,
  resultOverrides,
  reviewItems,
  sessions,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { report } from "@/community/moderation";
import { reply } from "@/community/posts";
import { createThread } from "@/community/threads";
import { openGame } from "@/game/lineups";
import { createScoreHandlers, enqueueScoring } from "@/game/score-jobs";
import { banUser } from "@/identity/roles";
import { setTrustLevel } from "@/identity/trust";
import type { Viewer } from "@/identity/viewer";
import { runDue } from "@/jobs/runner";
import { simulatedClock } from "@/lib/clock";
import { getSessionContext } from "@/results/session-context";
import { advanceStatus } from "@/results/status";
import { openReviewItem } from "@/reference/review";
import { setSimulatedClock } from "@/replay/clock-loop";
import { reviewItem } from "./review";
import { overrideResult } from "./results";
import { dryRunGame } from "@/game/corrections";
import { STAFF_WRITES } from "@/server/staff-writes";
import { runStaff, type StaffFnDef } from "@/server/staff-fn";

// The roadmap's first key test for M8 (Task 15): every staff write the
// screens can call, run once through `staffFn`'s guard with valid input,
// writes one audit row per change, each with the reason and the call's
// request id; and with a blank reason it is refused and writes nothing.

type WriteName = keyof typeof STAFF_WRITES;
type TestDb = Awaited<ReturnType<typeof createTestDb>>["db"];

/** One write's world: when it runs, its valid input, and how many changes. */
type Prepared = { now: Date; input: Record<string, unknown> };
type Case = {
  /** How many things the valid call changes: one audit row each. */
  changes: number;
  /** The input field holding the reason (availability calls it the note). */
  reasonKey?: string;
  prepare: (db: TestDb, admin: Viewer) => Promise<Prepared>;
};

const REASON = "Checked against the FIA's published document";
const HOUR = 3_600_000;
const GAME_NOW = new Date("2026-02-01T09:00:00.000Z");
const RESULTS_NOW = new Date("2026-08-01T16:00:00.000Z");
const COMMUNITY_NOW = new Date("2026-03-07T12:00:00.000Z");

/** The recorded 2026 game, open, with its clock at `GAME_NOW`. */
async function gameWorld(db: TestDb) {
  const game = await seedGame2026(db as Db, GAME_NOW);
  await setSimulatedClock(db, GAME_NOW);
  await openGame(db as Db, GAME_NOW, game.gameId);
  const driverOf = async (key: string) => {
    const [asset] = await db
      .select({ driverId: poolAssets.driverId })
      .from(poolAssets)
      .where(eq(poolAssets.id, await game.assetId(key)));
    return asset!.driverId!;
  };
  return {
    game,
    round1: await round2026(db as Db, 1),
    round2: await round2026(db as Db, 2),
    driverOf,
  };
}

/** Round 14's qualifying, ingested and provisional, at `RESULTS_NOW`. */
async function resultsWorld(db: TestDb) {
  await seedWorldWithSeats(db as Db);
  const sessionId = await sessionIdFor(db as Db, 14, "qualifying");
  await seedEntriesFor(db as Db, sessionId);
  const at = new Date(RESULTS_NOW.getTime() - HOUR);
  await ingest(
    db as Db,
    at,
    sessionId,
    "qualifying",
    loadBody("jolpica/2026/r14-qualifying.json"),
  );
  await advanceStatus(db as Db, at, sessionId);
  return { sessionId, norris: await idFor(db as Db, "driver", "norris") };
}

/** The 2026 game with round 1's race scored: something a dry run can re-run. */
async function scoredWorld(db: TestDb) {
  const clock = simulatedClock(GAME_NOW);
  const { game, round1 } = await gameWorld(db);
  await lockRound(db, game.gameId, round1.id);
  const race = await sessionOf(db as Db, round1.id, "race");
  const after = new Date(race.scheduledEnd.getTime() + HOUR);
  clock.set(after);
  await setSimulatedClock(db, after);
  await ingest(
    db as Db,
    after,
    race.id,
    "race",
    loadBody("jolpica/2026/r01-results.json"),
  );
  const { resultsVersion } = await advanceStatus(db as Db, after, race.id);
  await enqueueScoring(db as Db, after, {
    sessionId: race.id,
    stamp: `v${resultsVersion}`,
    trigger: "results",
  });
  const ran = await runDue(db as Db, clock, createScoreHandlers(), {
    maxJobs: 50,
    leaseMs: 300_000,
  });
  if (ran.failed !== 0) throw new Error("scoring failed");
  return { gameId: game.gameId, now: new Date(after.getTime() + HOUR) };
}

/** A user for the users screen's writes to act on. */
const target = async (db: TestDb) =>
  (await seedViewer(db as Db, { username: "Target", trustLevel: 1 })).userId;

const CASES: Record<
  Exclude<WriteName, "syncCalendarNow" | "checkProvider" | "viewAsUser">,
  Case
> = {
  saveLock: {
    changes: 1,
    prepare: async (db) => {
      const { round2 } = await gameWorld(db);
      return {
        now: GAME_NOW,
        input: {
          mode: "hand",
          eventId: round2.id,
          lockAt: new Date(round2.lockAt.getTime() - HOUR).toISOString(),
          reason: REASON,
        },
      };
    },
  },
  saveSession: {
    changes: 1,
    prepare: async (db) => {
      const { round2 } = await gameWorld(db);
      const [session] = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.eventId, round2.id), eq(sessions.kind, "race")));
      return {
        now: GAME_NOW,
        input: { sessionId: session!.id, status: "suspended", reason: REASON },
      };
    },
  },
  cancelCalendarEvent: {
    changes: 1,
    prepare: async (db) => {
      const { round2 } = await gameWorld(db);
      return { now: GAME_NOW, input: { eventId: round2.id, reason: REASON } };
    },
  },
  moveDriver: {
    changes: 1,
    prepare: async (db) => {
      const { round2, driverOf } = await gameWorld(db);
      return {
        now: GAME_NOW,
        input: {
          fromEventId: round2.id,
          driverId: await driverOf("bearman"),
          constructorId: null,
          reason: REASON,
        },
      };
    },
  },
  addDriver: {
    // The substitute's seat, and their entry for the event.
    changes: 2,
    prepare: async (db) => {
      const { round2 } = await gameWorld(db);
      return {
        now: GAME_NOW,
        input: {
          eventId: round2.id,
          inDriverId: await idFor(db as Db, "driver", "tsunoda"),
          constructorId: await idFor(db as Db, "constructor", "haas"),
          carNumber: 22,
          outDriverId: await idFor(db as Db, "driver", "ocon"),
          reason: REASON,
        },
      };
    },
  },
  saveAvailability: {
    changes: 1,
    reasonKey: "note",
    prepare: async (db) => {
      const { round1, driverOf } = await gameWorld(db);
      return {
        now: GAME_NOW,
        input: {
          eventId: round1.id,
          driverId: await driverOf("bearman"),
          status: "doubtful",
          note: REASON,
        },
      };
    },
  },
  saveCorrection: {
    changes: 1,
    prepare: async (db) => {
      const { sessionId, norris } = await resultsWorld(db);
      return {
        now: RESULTS_NOW,
        input: {
          sessionId,
          driverId: norris,
          what: "position",
          value: "2",
          reason: REASON,
        },
      };
    },
  },
  revokeCorrection: {
    changes: 1,
    prepare: async (db) => {
      const { sessionId, norris } = await resultsWorld(db);
      await overrideResult(db as Db, RESULTS_NOW, {
        sessionId,
        driverId: norris,
        fields: { position: 2 },
        reason: "Lap time deleted",
        actor: { kind: "admin", label: "setup", requestId: "setup" },
      });
      const [override] = await db
        .select({ id: resultOverrides.id })
        .from(resultOverrides)
        .where(eq(resultOverrides.driverId, norris));
      return {
        now: new Date(RESULTS_NOW.getTime() + HOUR),
        input: { overrideId: override!.id, reason: REASON },
      };
    },
  },
  startScoringDryRun: {
    changes: 1,
    prepare: async (db) => {
      const { gameId, now } = await scoredWorld(db);
      return { now, input: { gameId, reason: REASON } };
    },
  },
  approveScoring: {
    changes: 1,
    prepare: async (db) => {
      const { gameId, now } = await scoredWorld(db);
      const { dryRunId } = await dryRunGame(
        db as Db,
        now,
        { kind: "admin", label: "setup", requestId: "setup" },
        { gameId, reason: "Setup" },
      );
      return {
        now: new Date(now.getTime() + HOUR),
        input: { gameId, dryRunId, reason: REASON },
      };
    },
  },
  discardScoring: {
    changes: 1,
    prepare: async (db) => {
      const { gameId, now } = await scoredWorld(db);
      await dryRunGame(
        db as Db,
        now,
        { kind: "admin", label: "setup", requestId: "setup" },
        { gameId, reason: "Setup" },
      );
      return {
        now: new Date(now.getTime() + HOUR),
        input: { gameId, reason: REASON },
      };
    },
  },
  savePrice: {
    changes: 1,
    prepare: async (db) => {
      const { game, round2 } = await gameWorld(db);
      return {
        now: GAME_NOW,
        input: {
          gameId: game.gameId,
          eventId: round2.id,
          assetId: await game.assetId("norris"),
          price: "27.5",
          reason: REASON,
        },
      };
    },
  },
  resolveReview: {
    changes: 1,
    prepare: async (db) => {
      await seedWorldWithSeats(db as Db);
      const sessionId = await sessionIdFor(db as Db, 18, "race");
      const ctx = await getSessionContext(db as Db, sessionId);
      await openReviewItem(db as Db, RESULTS_NOW, {
        kind: "poll_gave_up",
        severity: "blocking",
        seasonId: ctx.seasonId,
        eventId: ctx.eventId,
        sessionId,
        driverId: null,
        details: {},
        dedupeKey: `test:poll_gave_up:${sessionId}`,
      });
      const [item] = await db
        .select({ id: reviewItems.id })
        .from(reviewItems)
        .where(eq(reviewItems.dedupeKey, `test:poll_gave_up:${sessionId}`));
      const detail = (await reviewItem(db as Db, item!.id))!;
      return {
        now: new Date(RESULTS_NOW.getTime() + HOUR),
        input: {
          id: detail.id,
          version: detail.version,
          actionId: detail.actions[detail.actions.length - 1]!.id,
          reason: REASON,
        },
      };
    },
  },
  moderateItem: {
    changes: 1,
    prepare: async (db) => {
      const author = await seedViewer(db as Db, {
        trustLevel: 1,
        username: "author",
      });
      const thread = await createThread(db as Db, COMMUNITY_NOW, author, {
        categoryId: await categoryId(db as Db, "general"),
        title: "Russell wins in Monaco",
        body: "What a drive.",
        containsSpoilers: true,
      });
      if (!thread.ok) throw new Error(thread.error);
      const post = await reply(db as Db, COMMUNITY_NOW, author, {
        threadId: thread.threadId,
        body: "Buy cheap tickets",
      });
      if (!post.ok) throw new Error(post.error);
      const reporter = await seedViewer(db as Db, {
        trustLevel: 3,
        username: "reporter",
      });
      const filed = await report(
        db as Db,
        COMMUNITY_NOW,
        reporter,
        { targetType: "post", targetId: post.postId, reason: "spam" },
        { verifyCaptcha: async () => true },
      );
      if (!filed.ok) throw new Error(filed.error);
      const [item] = await db
        .select({ version: modQueueItems.version })
        .from(modQueueItems)
        .where(eq(modQueueItems.id, filed.queueItemId));
      return {
        now: new Date(COMMUNITY_NOW.getTime() + HOUR),
        input: {
          id: filed.queueItemId,
          version: item!.version,
          action: "remove",
          reason: REASON,
        },
      };
    },
  },
  saveUserRole: {
    changes: 1,
    prepare: async (db) => ({
      now: GAME_NOW,
      input: { userId: await target(db), role: "moderator", reason: REASON },
    }),
  },
  banAccount: {
    changes: 1,
    prepare: async (db) => ({
      now: GAME_NOW,
      input: { userId: await target(db), days: 7, reason: REASON },
    }),
  },
  unbanAccount: {
    changes: 1,
    prepare: async (db, admin) => {
      const userId = await target(db);
      await banUser(db as Db, GAME_NOW, admin, {
        targetUserId: userId,
        reason: "Setup",
        until: null,
      });
      return {
        now: new Date(GAME_NOW.getTime() + HOUR),
        input: { userId, reason: REASON },
      };
    },
  },
  saveTrustLevel: {
    changes: 1,
    prepare: async (db) => ({
      now: GAME_NOW,
      input: { userId: await target(db), level: 2, reason: REASON },
    }),
  },
  releaseTrustLock: {
    changes: 1,
    prepare: async (db, admin) => {
      const userId = await target(db);
      await setTrustLevel(db as Db, GAME_NOW, {
        userId,
        level: 2,
        reason: "Setup",
        actor: {
          kind: "admin",
          label: "setup",
          userId: admin.userId,
          requestId: "setup",
        },
      });
      return {
        now: new Date(GAME_NOW.getTime() + HOUR),
        input: { userId, reason: REASON },
      };
    },
  },
  restrictUser: {
    changes: 1,
    prepare: async (db) => ({
      now: GAME_NOW,
      input: {
        userId: await target(db),
        action: "mute",
        hours: 24,
        reason: REASON,
      },
    }),
  },
  moveReplayClock: {
    changes: 1,
    // A replay database whose clock stands still (no offset yet): resuming
    // it is one change.
    prepare: async (db) => {
      await setSimulatedClock(db, GAME_NOW);
      return { now: GAME_NOW, input: { action: "resume", reason: REASON } };
    },
  },
  saveStaffSettings: {
    changes: 1,
    prepare: async () => ({
      now: GAME_NOW,
      input: {
        reason: REASON,
        values: { feature_flags: { chat: false, push: true } },
      },
    }),
  },
};

/**
 * The writes this test can't run whole, and what it checks of each instead:
 * two take no reason (they only move a job earlier, which no audit row
 * records), and viewing the site as someone runs Better Auth on the request,
 * so its audit row is `identity/impersonation.test.ts`'s.
 */
const EXEMPT: Record<
  Exclude<WriteName, keyof typeof CASES>,
  { input: Record<string, unknown>; refused: "invalid" | "reason_required" }
> = {
  syncCalendarNow: {
    input: { season: 2026, reason: REASON },
    refused: "invalid",
  },
  checkProvider: {
    input: {
      sessionId: "019a0000-0000-7000-8000-000000000000",
      reason: REASON,
    },
    refused: "invalid",
  },
  viewAsUser: {
    input: { userId: "019a0000-0000-7000-8000-000000000000", reason: "   " },
    refused: "reason_required",
  },
};

/** An admin with TOTP on and the session unlocked, as `requireStaff` wants. */
async function unlockedAdmin(db: TestDb, now: Date): Promise<Viewer> {
  const viewer = await seedViewer(db as Db, {
    username: "staffadmin",
    role: "admin",
  });
  return { ...viewer, twoFactorEnabled: true, staffVerifiedAt: now };
}

async function auditCount(db: TestDb): Promise<number> {
  const [row] = await db.select({ n: count() }).from(auditLog);
  return row!.n;
}

describe("every staff write (M8 Task 15)", () => {
  it("the list here matches staff.ts's POST server functions", () => {
    const source = readFileSync(
      new URL("../server/staff.ts", import.meta.url),
      "utf8",
    );
    const posts = [
      ...source.matchAll(
        /export const (\w+) = createServerFn\(\{ method: "POST" \}\)/g,
      ),
    ].map((m) => m[1]);
    expect(Object.keys(STAFF_WRITES).sort()).toEqual(posts.sort());
    expect([...Object.keys(CASES), ...Object.keys(EXEMPT)].sort()).toEqual(
      Object.keys(STAFF_WRITES).sort(),
    );
    // Each POST hands staffFn its definition from STAFF_WRITES.
    for (const name of posts) {
      expect(source).toMatch(
        new RegExp(
          `export const ${name} = createServerFn\\(\\{ method: "POST" \\}\\)\\s*\\.validator\\(staffInput\\)\\s*\\.handler\\(staffFn\\(WRITES\\.(STAFF_WRITES\\.${name}|[A-Z_]+)\\)\\)`,
        ),
      );
    }
  });

  describe.each(Object.entries(EXEMPT))("%s", (name, { input, refused }) => {
    it("refuses a reason it doesn't take, or a blank one, and writes nothing", async () => {
      const t = await createTestDb();
      try {
        const admin = await unlockedAdmin(t.db, GAME_NOW);
        const def = STAFF_WRITES[name as WriteName] as StaffFnDef<
          unknown,
          unknown
        >;
        const result = await runStaff(def, admin, input, (fn) =>
          fn(t.db as unknown as Db, GAME_NOW),
        );
        expect(result).toEqual({ ok: false, error: refused });
        expect(await auditCount(t.db)).toBe(0);
      } finally {
        await t.close();
      }
    });
  });

  describe.each(Object.entries(CASES))("%s", (name, c) => {
    let t: Awaited<ReturnType<typeof createTestDb>>;
    let admin: Viewer;
    let prepared: Prepared;
    const def = STAFF_WRITES[name as WriteName] as StaffFnDef<unknown, unknown>;
    const reasonKey = c.reasonKey ?? "reason";
    const call = (input: Record<string, unknown>) =>
      runStaff(def, admin, input, (fn) =>
        fn(t.db as unknown as Db, prepared.now),
      );

    beforeAll(async () => {
      t = await createTestDb();
      admin = await unlockedAdmin(t.db, GAME_NOW);
      prepared = await c.prepare(t.db, admin);
    }, 120_000);
    afterAll(async () => {
      await t.close();
    });

    it("with a blank reason it is refused with reason_required and writes nothing", async () => {
      const before = await auditCount(t.db);
      const result = await call({ ...prepared.input, [reasonKey]: "   " });
      expect(result).toEqual({ ok: false, error: "reason_required" });
      expect(await auditCount(t.db)).toBe(before);
    });

    it("writes exactly one audit row per change, with a non-blank reason and the request id", async () => {
      const before = (
        await t.db.select({ id: auditLog.id }).from(auditLog)
      ).map((r) => r.id);
      const result = await call(prepared.input);
      expect(result).toMatchObject({ ok: true });
      const rows = (await t.db.select().from(auditLog)).filter(
        (r) => !before.includes(r.id),
      );
      expect(rows.map((r) => r.action)).toHaveLength(c.changes);
      const requestIds = new Set(rows.map((r) => r.requestId));
      expect(requestIds.size).toBe(1);
      expect([...requestIds][0]).toMatch(/^web:[0-9a-f-]{36}$/);
      for (const row of rows) {
        expect(row.reason).toBe(REASON);
        expect(row.actorUserId).toBe(admin.userId);
      }
    });
  });
});
