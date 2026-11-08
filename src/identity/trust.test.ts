import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import { seedUser } from "../../tests/helpers/users";
import { auditLog, profiles, trustLevelChanges } from "@/db/schema";
import { settingDefaults } from "@/settings/defaults";
import {
  clearTrustLock,
  computeTrustLevel,
  recomputeTrustLevels,
  setTrustLevel,
  type TrustCounts,
  type TrustInput,
} from "./trust";

const NOW = new Date("2026-11-08T06:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const T = settingDefaults.trust_thresholds;

const input = (over: Partial<TrustInput>): TrustInput => ({
  current: 0,
  daysVisited: 0,
  posts: 0,
  reputation: 0,
  upheldActions: 0,
  accountAgeDays: 1000,
  ...over,
});

describe("computeTrustLevel", () => {
  const meets = (level: 1 | 2 | 3): Partial<TrustInput> => ({
    daysVisited: T[`tl${level}`].daysVisited,
    posts: T[`tl${level}`].posts,
    reputation: T[`tl${level}`].reputation,
  });
  const cases: Array<[string, Partial<TrustInput>, number]> = [
    ["nothing", {}, 0],
    ["TL1 met", meets(1), 1],
    ["TL1 one day short", { ...meets(1), daysVisited: 2 }, 0],
    ["TL1 one post short", { ...meets(1), posts: 9 }, 0],
    ["TL1 account too young", { ...meets(1), accountAgeDays: 2 }, 0],
    ["TL2 met", meets(2), 2],
    ["TL2 one day short", { ...meets(2), daysVisited: 14 }, 1],
    ["TL2 one post short", { ...meets(2), posts: 49 }, 1],
    ["TL2 one reputation short", { ...meets(2), reputation: 24 }, 1],
    ["TL2 account too young", { ...meets(2), accountAgeDays: 14 }, 1],
    ["TL3 met", meets(3), 3],
    ["TL3 one day short", { ...meets(3), daysVisited: 59 }, 2],
    ["TL3 one post short", { ...meets(3), posts: 199 }, 2],
    ["TL3 one reputation short", { ...meets(3), reputation: 199 }, 2],
    ["TL3 account too young", { ...meets(3), accountAgeDays: 59 }, 2],
  ];
  it.each(cases)("each threshold, either side: %s", (_n, over, expected) => {
    expect(computeTrustLevel(input(over), T)).toBe(expected);
  });

  it("going quiet never lowers a level", () => {
    expect(computeTrustLevel(input({ current: 3 }), T)).toBe(3);
    expect(computeTrustLevel(input({ current: 2, posts: 1 }), T)).toBe(2);
  });

  it("an upheld action can", () => {
    expect(computeTrustLevel(input({ current: 3, upheldActions: 1 }), T)).toBe(
      0,
    );
    expect(
      computeTrustLevel(
        input({ current: 3, upheldActions: 2, ...meets(1) }),
        T,
      ),
    ).toBe(1);
  });
});

describe("trust levels in the database", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.close();
  });

  const seen = (days = 1) => new Date(NOW.getTime() - days * DAY);
  const profile = async (userId: string) =>
    (await t.db.select().from(profiles).where(eq(profiles.userId, userId)))[0]!;
  const changes = (userId: string) =>
    t.db
      .select()
      .from(trustLevelChanges)
      .where(eq(trustLevelChanges.userId, userId))
      .orderBy(asc(trustLevelChanges.changedAt));
  /** A user who has visited enough for TL1, with posts the counts supply. */
  const seedActive = async (
    over: Partial<typeof profiles.$inferInsert> = {},
  ) => {
    const id = await seedUser(t.db);
    await t.db
      .update(profiles)
      .set({ daysVisited: 5, lastSeenAt: seen(), ...over })
      .where(eq(profiles.userId, id));
    return id;
  };
  const withPosts =
    (posts: number, upheldActions = 0): TrustCounts =>
    async (_db, ids) =>
      new Map(ids.map((id) => [id, { posts, upheldActions }]));

  it("each change writes a history row", async () => {
    const id = await seedActive();
    const r = await recomputeTrustLevels(t.db, NOW, { counts: withPosts(10) });
    expect(r.changed).toBe(1);
    expect((await profile(id)).trustLevel).toBe(1);
    expect(await changes(id)).toMatchObject([
      { fromLevel: 0, toLevel: 1, source: "auto", changedBy: null },
    ]);
  });

  it("the default counts leave everyone at TL0", async () => {
    const id = await seedActive();
    expect((await recomputeTrustLevels(t.db, NOW)).changed).toBe(0);
    expect((await profile(id)).trustLevel).toBe(0);
  });

  it("running it twice writes nothing new", async () => {
    const id = await seedActive();
    await recomputeTrustLevels(t.db, NOW, { counts: withPosts(10) });
    const again = await recomputeTrustLevels(t.db, NOW, {
      counts: withPosts(10),
    });
    expect(again.changed).toBe(0);
    expect(await changes(id)).toHaveLength(1);
  });

  it("an upheld action lowers the level and is recorded", async () => {
    const id = await seedActive({ trustLevel: 2 });
    await recomputeTrustLevels(t.db, NOW, { counts: withPosts(0, 1) });
    expect((await profile(id)).trustLevel).toBe(0);
    expect(await changes(id)).toMatchObject([{ fromLevel: 2, toLevel: 0 }]);
  });

  it("only users seen in the last 30 days are looked at", async () => {
    const quiet = await seedActive({ lastSeenAt: seen(31) });
    const never = await seedActive({ lastSeenAt: null });
    expect(
      (await recomputeTrustLevels(t.db, NOW, { counts: withPosts(10) }))
        .changed,
    ).toBe(0);
    expect((await profile(quiet)).trustLevel).toBe(0);
    expect((await profile(never)).trustLevel).toBe(0);
  });

  it("a locked user is skipped", async () => {
    const id = await seedActive({ trustLevelLocked: true });
    const r = await recomputeTrustLevels(t.db, NOW, { counts: withPosts(10) });
    expect(r.changed).toBe(0);
    expect((await profile(id)).trustLevel).toBe(0);
    expect(await changes(id)).toHaveLength(0);
  });

  it("a deleted user is skipped", async () => {
    const id = await seedActive({ status: "deleted" });
    const r = await recomputeTrustLevels(t.db, NOW, { counts: withPosts(10) });
    expect(r.changed).toBe(0);
    expect((await profile(id)).trustLevel).toBe(0);
  });

  it("works through more users than one batch", async () => {
    const ids = [await seedActive(), await seedActive(), await seedActive()];
    const r = await recomputeTrustLevels(t.db, NOW, {
      counts: withPosts(10),
      batch: 2,
    });
    expect(r.changed).toBe(3);
    for (const id of ids) expect((await profile(id)).trustLevel).toBe(1);
  });

  describe("a moderator's change", () => {
    const actor = (userId: string) => ({
      kind: "moderator" as const,
      label: "mod",
      userId,
      requestId: "req-1",
    });

    it("locks and is audited", async () => {
      const id = await seedActive();
      const mod = await seedUser(t.db, { role: "moderator" });
      await setTrustLevel(t.db, NOW, {
        userId: id,
        level: 2,
        reason: "long-time helper",
        actor: actor(mod),
      });
      expect(await profile(id)).toMatchObject({
        trustLevel: 2,
        trustLevelLocked: true,
      });
      expect(await changes(id)).toMatchObject([
        {
          fromLevel: 0,
          toLevel: 2,
          source: "moderator",
          changedBy: mod,
          reason: "long-time helper",
        },
      ]);
      const [row] = await t.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.entityId, id));
      expect(row).toMatchObject({
        action: "user.trust_level.set",
        actorKind: "moderator",
        actorUserId: mod,
        reason: "long-time helper",
        before: { trustLevel: 0, trustLevelLocked: false },
        after: { trustLevel: 2, trustLevelLocked: true },
      });
      // And the nightly job now leaves it.
      await recomputeTrustLevels(t.db, NOW, { counts: withPosts(0, 1) });
      expect((await profile(id)).trustLevel).toBe(2);
    });

    it("needs a reason and a level from 0 to 3", async () => {
      const id = await seedActive();
      const mod = await seedUser(t.db, { role: "moderator" });
      await expect(
        setTrustLevel(t.db, NOW, {
          userId: id,
          level: 1,
          reason: "  ",
          actor: actor(mod),
        }),
      ).rejects.toThrow();
      await expect(
        setTrustLevel(t.db, NOW, {
          userId: id,
          level: 4 as 3,
          reason: "x",
          actor: actor(mod),
        }),
      ).rejects.toThrow();
      expect(await changes(id)).toHaveLength(0);
    });

    it("clearing the lock is audited and lets the job work again", async () => {
      const id = await seedActive();
      const mod = await seedUser(t.db, { role: "moderator" });
      await setTrustLevel(t.db, NOW, {
        userId: id,
        level: 1,
        reason: "r",
        actor: actor(mod),
      });
      await clearTrustLock(t.db, NOW, {
        userId: id,
        reason: "back to automatic",
        actor: actor(mod),
      });
      expect((await profile(id)).trustLevelLocked).toBe(false);
      const rows = await t.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "user.trust_level.unlock"));
      expect(rows).toHaveLength(1);
    });
  });
});
