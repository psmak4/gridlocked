import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import { seedUser } from "../../tests/helpers/users";
import { reviewItems } from "@/db/schema";
import type { Db } from "@/db/types";
import { openReviewItem } from "@/reference/review";
import { resolveVersioned } from "./versioned";

const NOW = new Date("2026-11-21T09:00:00.000Z");

describe("resolveVersioned (M8 Task 3)", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: Db;
  let itemId: string;
  let admin: string;
  const item = async () =>
    (await db.select().from(reviewItems).where(eq(reviewItems.id, itemId)))[0]!;
  const resolve = (tx: Db, version: number) =>
    resolveVersioned(
      tx,
      reviewItems,
      { id: itemId, version },
      {
        status: "resolved",
        resolution: "Checked by hand",
        resolvedBy: admin,
        resolvedAt: NOW,
      },
    );

  beforeEach(async () => {
    t = await createTestDb();
    db = t.db as unknown as Db;
    admin = await seedUser(db, { role: "admin" });
    await openReviewItem(db, NOW, {
      kind: "staff_verify_locked",
      seasonId: null,
      details: { userId: admin },
      dedupeKey: "test-item",
    });
    itemId = (await db.select().from(reviewItems))[0]!.id;
  });
  afterEach(async () => {
    await t.close();
  });

  it("resolveVersioned updates an open item at its version and bumps the version", async () => {
    const before = await item();
    expect(await resolve(db, before.version)).toBe(true);
    expect(await item()).toMatchObject({
      status: "resolved",
      resolution: "Checked by hand",
      resolvedBy: admin,
      version: before.version + 1,
    });
  });

  it("resolveVersioned with an old version updates nothing and returns false", async () => {
    const before = await item();
    expect(await resolve(db, before.version - 1)).toBe(false);
    expect(await item()).toEqual(before);
    // Nor a second time at the version it had: it isn't open any more.
    expect(await resolve(db, before.version)).toBe(true);
    expect(await resolve(db, before.version + 1)).toBe(false);
  });

  it("two resolveVersioned calls at the same version in parallel transactions: exactly one returns true", async () => {
    const { version } = await item();
    const results = await Promise.all([
      db.transaction((tx) => resolve(tx as unknown as Db, version)),
      db.transaction((tx) => resolve(tx as unknown as Db, version)),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await item()).version).toBe(version + 1);
  });
});
