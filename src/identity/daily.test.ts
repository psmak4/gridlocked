import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import { seedUser } from "../../tests/helpers/users";
import {
  authRateLimits,
  authSessions,
  authVerifications,
  emailOutbox,
  jobs,
  profiles,
  usernameHistory,
} from "@/db/schema";
import { newId } from "@/lib/ids";
import { simulatedClock } from "@/lib/clock";
import type { Job } from "@/jobs/queue";
import { createIdentityDailyHandler, pruneIdentity } from "./daily";

const NOW = new Date("2026-11-08T06:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);
const ahead = (days: number) => new Date(NOW.getTime() + days * DAY);

describe("pruneIdentity", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.close();
  });

  const session = async (userId: string, expiresAt: Date) => {
    const id = newId();
    await t.db.insert(authSessions).values({
      id,
      userId,
      expiresAt,
      token: `tok-${id}`,
      createdAt: ago(40),
      updatedAt: ago(40),
    });
    return id;
  };
  const verification = async (expiresAt: Date) => {
    const id = `v-${newId()}`;
    await t.db.insert(authVerifications).values({
      id,
      identifier: "x",
      value: "y",
      expiresAt,
      createdAt: ago(40),
      updatedAt: ago(40),
    });
    return id;
  };
  const rateLimit = async (lastRequest: Date) => {
    const id = newId();
    await t.db.insert(authRateLimits).values({
      id,
      key: `k-${id}`,
      count: 1,
      lastRequest: lastRequest.getTime(),
    });
    return id;
  };
  const outbox = async (
    status: "queued" | "sent" | "failed" | "expired",
    at: Date,
  ) => {
    const id = newId();
    await t.db.insert(emailOutbox).values({
      id,
      toEmail: status === "queued" ? `q-${id}@example.test` : null,
      template: "verify_email",
      status,
      sendAfter: at,
      createdAt: at,
      sentAt: status === "sent" ? at : null,
    });
    return id;
  };
  const ids = async (
    rows: Promise<Array<{ id: string }>>,
  ): Promise<Set<string>> => new Set((await rows).map((r) => r.id));
  const remaining = {
    sessions: () =>
      ids(t.db.select({ id: authSessions.id }).from(authSessions)),
    verifications: () =>
      ids(t.db.select({ id: authVerifications.id }).from(authVerifications)),
    rateLimits: () =>
      ids(t.db.select({ id: authRateLimits.id }).from(authRateLimits)),
    outbox: () => ids(t.db.select({ id: emailOutbox.id }).from(emailOutbox)),
  };

  it("expired rows go, live ones stay: auth_sessions", async () => {
    const u = await seedUser(t.db);
    const old = await session(u, ago(1));
    const live = await session(u, ahead(1));
    await pruneIdentity(t.db, NOW);
    expect(await remaining.sessions()).toEqual(new Set([live]));
    expect(old).not.toBe(live);
  });

  it("expired rows go, live ones stay: auth_verifications", async () => {
    const old = await verification(ago(1));
    const live = await verification(ahead(1));
    await pruneIdentity(t.db, NOW);
    expect(await remaining.verifications()).toEqual(new Set([live]));
    expect(old).not.toBe(live);
  });

  it("expired rows go, live ones stay: auth_rate_limits", async () => {
    // A window is over once its last request is a day old.
    const old = await rateLimit(ago(2));
    const live = await rateLimit(new Date(NOW.getTime() - 60_000));
    await pruneIdentity(t.db, NOW);
    expect(await remaining.rateLimits()).toEqual(new Set([live]));
    expect(old).not.toBe(live);
  });

  it("expired rows go, live ones stay: email_outbox", async () => {
    const oldSent = await outbox("sent", ago(36));
    const oldFailed = await outbox("failed", ago(36));
    const oldExpired = await outbox("expired", ago(36));
    const recentSent = await outbox("sent", ago(34));
    const oldQueued = await outbox("queued", ago(36));
    await pruneIdentity(t.db, NOW);
    expect(await remaining.outbox()).toEqual(new Set([recentSent, oldQueued]));
    expect(new Set([oldSent, oldFailed, oldExpired]).size).toBe(3);
  });

  describe("username history", () => {
    const history = async (userId: string, username: string, at: Date) => {
      await t.db.insert(usernameHistory).values({
        id: newId(),
        userId,
        username,
        changedAt: at,
      });
    };
    const names = async () =>
      (await t.db.select().from(usernameHistory)).map((r) => r.username).sort();

    it("a tombstone's old name is released after 90 days", async () => {
      const gone = await seedUser(t.db);
      await t.db
        .update(profiles)
        .set({ status: "deleted" })
        .where(eq(profiles.userId, gone));
      await history(gone, "old_name", ago(91));
      await history(gone, "recent_name", ago(89));
      await pruneIdentity(t.db, NOW);
      expect(await names()).toEqual(["recent_name"]);
    });

    it("a live user's history stays", async () => {
      const live = await seedUser(t.db);
      await history(live, "ancient", ago(400));
      await pruneIdentity(t.db, NOW);
      expect(await names()).toEqual(["ancient"]);
    });
  });
});

describe("the identity_daily handler", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await t.close();
  });

  const run = (handler: ReturnType<typeof createIdentityDailyHandler>) =>
    handler({} as Job, { db: t.db as never, clock: simulatedClock(NOW) });

  it("a failure in one step leaves the others done", async () => {
    const lines: string[] = [];
    const calls: string[] = [];
    const user = await seedUser(t.db);
    await t.db.insert(authSessions).values({
      id: newId(),
      userId: user,
      expiresAt: ago(1),
      token: "t",
      createdAt: ago(5),
      updatedAt: ago(5),
    });
    const handler = createIdentityDailyHandler({
      log: (l) => lines.push(l),
      steps: {
        recomputeTrustLevels: async () => {
          calls.push("trust");
          throw new Error("boom with secret@example.test");
        },
      },
    });
    await expect(run(handler)).rejects.toThrow(/recomputeTrustLevels/);
    expect(calls).toEqual(["trust"]);
    // The later steps ran: the expired session is gone.
    expect(await t.db.select().from(authSessions)).toHaveLength(0);
    const text = lines.join("\n");
    expect(text).toContain("recomputeTrustLevels failed (Error)");
    expect(text).toContain("purgeIncompleteAccounts");
    expect(text).toMatch(/purged=\d+ skipped=\d+/);
    expect(text).not.toContain("secret@example.test");
  });

  it("runs every step and queues no retry when all succeed", async () => {
    const lines: string[] = [];
    await run(createIdentityDailyHandler({ log: (l) => lines.push(l) }));
    expect(lines.join("\n")).toContain("pruneIdentity");
    expect(await t.db.select().from(jobs)).toHaveLength(0);
  });
});
