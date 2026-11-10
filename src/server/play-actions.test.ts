import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import { errorCode } from "../../tests/helpers/staff";
import { seedUser } from "../../tests/helpers/users";
import { profiles, sessionWatchMarks } from "@/db/schema";
import type { Db } from "@/db/types";
import { GameError } from "@/game/errors";
import type { Viewer } from "@/identity/viewer";
import { newId } from "@/lib/ids";
import { seedEventSessions } from "../../tests/helpers/sessions";
import {
  MAX_WATCH_MARKS,
  markSessionsWatchedAction,
  markSessionsWatchedInput,
  refusalOf,
} from "./play-actions";

const NOW = new Date("2026-03-09T09:00:00.000Z");

describe("refusalOf (the playAction wrapper's refusals)", () => {
  it("turns a GameError into { ok: false, error }", async () => {
    expect(
      await refusalOf(async () => {
        throw new GameError("over_budget", "too dear");
      }),
    ).toEqual({ ok: false, error: "over_budget" });
  });

  it("passes an answer through", async () => {
    expect(await refusalOf(async () => ({ ok: true as const }))).toEqual({
      ok: true,
    });
  });

  it("lets anything else through as an error", async () => {
    await expect(
      refusalOf(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
  });
});

describe("markSessionsWatched's input", () => {
  const ids = (n: number) => Array.from({ length: n }, () => newId());

  it(`takes 1 to ${MAX_WATCH_MARKS} session ids`, () => {
    expect(MAX_WATCH_MARKS).toBe(10);
    expect(
      markSessionsWatchedInput.safeParse({ sessionIds: ids(1) }).success,
    ).toBe(true);
    expect(
      markSessionsWatchedInput.safeParse({ sessionIds: ids(10) }).success,
    ).toBe(true);
    expect(
      markSessionsWatchedInput.safeParse({ sessionIds: ids(11) }).success,
    ).toBe(false);
    expect(markSessionsWatchedInput.safeParse({ sessionIds: [] }).success).toBe(
      false,
    );
    expect(
      markSessionsWatchedInput.safeParse({ sessionIds: ["not-a-uuid"] })
        .success,
    ).toBe(false);
  });
});

describe("markSessionsWatchedAction", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: Db;

  beforeEach(async () => {
    t = await createTestDb();
    db = t.db as unknown as Db;
  });
  afterEach(async () => {
    await t.close();
  });

  async function viewerOf(
    userId: string,
    over: Partial<Viewer> = {},
  ): Promise<Viewer> {
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
      ...over,
    };
  }

  const twoSessions = () =>
    seedEventSessions(
      db,
      new Date("2026-03-07T05:00:00Z"),
      new Date("2026-03-08T04:00:00Z"),
    );

  it("marks the sessions watched for the viewer", async () => {
    const sessionIds = await twoSessions();
    const userId = await seedUser(db);

    expect(
      await markSessionsWatchedAction(db, NOW, await viewerOf(userId), {
        sessionIds,
      }),
    ).toEqual({ ok: true });
    const rows = await db
      .select({ sessionId: sessionWatchMarks.sessionId })
      .from(sessionWatchMarks)
      .where(eq(sessionWatchMarks.userId, userId));
    expect(rows.map((r) => r.sessionId).sort()).toEqual([...sessionIds].sort());
  });

  it("needs a writable viewer", async () => {
    const sessionIds = await twoSessions();
    const userId = await seedUser(db);
    const admin = await seedUser(db, { role: "admin" });

    expect(
      await errorCode(() =>
        markSessionsWatchedAction(db, NOW, null, { sessionIds }),
      ),
    ).toBe("unauthenticated");
    expect(
      await errorCode(async () =>
        markSessionsWatchedAction(
          db,
          NOW,
          await viewerOf(userId, { complete: false }),
          { sessionIds },
        ),
      ),
    ).toBe("incomplete");
    expect(
      await errorCode(async () =>
        markSessionsWatchedAction(
          db,
          NOW,
          await viewerOf(userId, { impersonatedBy: admin }),
          { sessionIds },
        ),
      ),
    ).toBe("read_only");
    expect(await db.select().from(sessionWatchMarks)).toEqual([]);
  });
});
