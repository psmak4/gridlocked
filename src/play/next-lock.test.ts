import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { round2026, seedGame2026 } from "../../tests/helpers/game-2026";
import { createTestDb } from "../../tests/helpers/test-db";
import { events } from "@/db/schema";
import { nextLockAt } from "./next-lock";

// The public cache's stale window shortens near a lock (M9 Task 6): the
// price board needs the next lock to know.

describe("nextLockAt", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;

  beforeAll(async () => {
    t = await createTestDb();
    await seedGame2026(t.db, new Date("2026-02-01T00:00:00.000Z"));
  });
  afterAll(() => t.close());

  it("is the first lock at or after now, skipping a cancelled event", async () => {
    const one = await round2026(t.db, 1);
    const two = await round2026(t.db, 2);
    const three = await round2026(t.db, 3);
    expect(await nextLockAt(t.db, new Date(one.lockAt.getTime() - 1))).toEqual(
      one.lockAt,
    );
    expect(await nextLockAt(t.db, one.lockAt)).toEqual(one.lockAt);

    await t.db
      .update(events)
      .set({ status: "cancelled" })
      .where(eq(events.id, two.id));
    expect(await nextLockAt(t.db, new Date(one.lockAt.getTime() + 1))).toEqual(
      three.lockAt,
    );
  });

  it("is null after the last lock", async () => {
    expect(await nextLockAt(t.db, new Date("2027-06-01T00:00:00.000Z"))).toBe(
      null,
    );
  });
});
