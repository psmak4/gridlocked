import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import { settings } from "./schema";

describe("settings table", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;

  beforeEach(async () => {
    t = await createTestDb();
  });

  afterEach(async () => {
    await t.close();
  });

  it("round-trips a jsonb value and defaults version to 1", async () => {
    await t.db
      .insert(settings)
      .values({ key: "poll_minutes", value: [5, 15, 60] });

    const rows = await t.db
      .select()
      .from(settings)
      .where(eq(settings.key, "poll_minutes"));

    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.value).toEqual([5, 15, 60]);
    expect(row.version).toBe(1);
    expect(row.updatedBy).toBeNull();
    expect(row.updatedAt).toBeInstanceOf(Date);
  });
});
