import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../../tests/helpers/test-db";
import { providerRequests } from "@/db/schema";
import { newId } from "@/lib/ids";
import { ClockModeError } from "@/lib/resolve-clock";
import { setSimulatedClock } from "@/replay/clock-loop";
import { checkImportTarget } from "./import-target";

// Where `pnpm import:2026` may write (M9 Task 5): a fresh database in system
// mode, as before, or an empty replay database for the hosted beta.
describe("checkImportTarget", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.close();
  });

  const polled = () =>
    t.db.insert(providerRequests).values({
      id: newId(),
      provider: "jolpica",
      endpoint: "races",
      params: {},
      requestedAt: new Date("2026-03-06T10:00:00Z"),
      statusCode: 200,
      durationMs: 10,
      outcome: "new_snapshot",
    });

  it("the import runs on an empty replay database and refuses a used one", async () => {
    await setSimulatedClock(t.db, new Date("2026-02-27T00:00:00Z"));
    await expect(
      checkImportTarget(t.db, "replay", { force: false }),
    ).resolves.toBeUndefined();
    await polled();
    await expect(
      checkImportTarget(t.db, "replay", { force: false }),
    ).rejects.toThrow("has polled live data");
    // Not even with --force: the replay's results come from its own polls.
    await expect(
      checkImportTarget(t.db, "replay", { force: true }),
    ).rejects.toThrow("has polled live data");
  });

  it("replay mode needs the replay's clock set first", async () => {
    await expect(
      checkImportTarget(t.db, "replay", { force: false }),
    ).rejects.toBeInstanceOf(ClockModeError);
  });

  it("system mode is as before: a polled database only with --force, and no simulated clock", async () => {
    await expect(
      checkImportTarget(t.db, "system", { force: false }),
    ).resolves.toBeUndefined();
    await polled();
    await expect(
      checkImportTarget(t.db, "system", { force: false }),
    ).rejects.toThrow("Use --force");
    await expect(
      checkImportTarget(t.db, "system", { force: true }),
    ).resolves.toBeUndefined();
    await setSimulatedClock(t.db, new Date("2026-02-27T00:00:00Z"));
    await expect(
      checkImportTarget(t.db, "system", { force: true }),
    ).rejects.toBeInstanceOf(ClockModeError);
  });
});
