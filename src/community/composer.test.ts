import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import { seedViewer } from "../../tests/helpers/community";
import { seedEventSessions } from "../../tests/helpers/sessions";
import { composerData, writerOf } from "./composer";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

describe("the composer's data", () => {
  let t: TestDb;
  let ids: string[];

  beforeEach(async () => {
    t = await createTestDb();
    ids = await seedEventSessions(
      t.db,
      new Date("2026-06-05T11:30:00Z"),
      new Date("2026-06-05T15:00:00Z"),
      new Date("2026-06-06T10:30:00Z"),
      new Date("2026-06-06T14:00:00Z"),
      new Date("2026-06-07T13:00:00Z"),
    );
  });

  afterEach(async () => {
    await t.close();
  });

  it("TL0 can start nowhere; TL1 can start in all seven", async () => {
    const now = new Date("2026-06-06T18:00:00Z");
    const tl0 = writerOf(await seedViewer(t.db, { trustLevel: 0 }));
    expect(tl0).toEqual({ trustLevel: 0, canPost: true });
    expect((await composerData(t.db, now, tl0)).categories).toEqual([]);
    expect((await composerData(t.db, now, null)).categories).toEqual([]);
    const tl1 = writerOf(await seedViewer(t.db, { trustLevel: 1 }));
    expect((await composerData(t.db, now, tl1)).categories).toHaveLength(7);
    const mod = writerOf(await seedViewer(t.db, { role: "moderator" }));
    expect(mod?.trustLevel).toBe(3);
  });

  it("the spoiler session is the latest one that has started, inside its window", async () => {
    const saturday = await composerData(
      t.db,
      new Date("2026-06-06T18:00:00Z"),
      null,
    );
    expect(saturday.spoilerSession).toEqual({
      id: ids[3],
      label: "Qualifying",
      phrase: "qualifying",
      eventName: "Monaco Grand Prix",
    });
    const sunday = await composerData(
      t.db,
      new Date("2026-06-07T18:00:00Z"),
      null,
    );
    expect(sunday.spoilerSession?.phrase).toBe("the race");
    const later = await composerData(
      t.db,
      new Date("2026-06-15T18:00:00Z"),
      null,
    );
    expect(later.spoilerSession).toBeNull();
  });
});
