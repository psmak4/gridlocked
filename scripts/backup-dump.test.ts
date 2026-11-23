import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../tests/helpers/test-db";
import { seedUser } from "../tests/helpers/users";
import { parseCounts } from "./backup-check";
import { countRows, directUrl } from "./backup-dump";

// M9 Task 11: the dump's row counts, taken in its own snapshot, are what the
// restore drill compares against.

describe("directUrl", () => {
  it("swaps a Neon pooler host for the direct one, and leaves the rest", () => {
    expect(
      directUrl(
        "postgresql://app:pw@ep-cool-fog-123-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require",
      ),
    ).toBe(
      "postgresql://app:pw@ep-cool-fog-123.us-east-1.aws.neon.tech/neondb?sslmode=require",
    );
    expect(directUrl("postgresql://app:pw@localhost:5432/db")).toBe(
      "postgresql://app:pw@localhost:5432/db",
    );
  });
});

describe("countRows", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.close();
  });

  it("counts every table in the app's schema and the migrations' ledger", async () => {
    const count = async () =>
      parseCounts(await countRows((text) => t.client.query(text) as never));
    const before = await count();
    await seedUser(t.db);
    await seedUser(t.db);
    const counts = await count();
    // The migrations seed the system account; two more were added.
    expect(counts.get("public.users")).toBe(before.get("public.users")! + 2);
    expect(counts.get("public.profiles")).toBe(
      before.get("public.profiles")! + 2,
    );
    expect(counts.get("public.posts")).toBe(0);
    expect(counts.get("drizzle.__drizzle_migrations")).toBeGreaterThan(50);
    // Sorted, so two runs diff line by line.
    const tables = [...counts.keys()];
    expect(tables).toEqual([...tables].sort());
  });
});
