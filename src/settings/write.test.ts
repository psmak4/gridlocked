import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import { auditLog, settings } from "@/db/schema";
import type { StaffActor } from "@/staff/roster";
import { getSetting } from "./index";
import { EDITABLE_SETTINGS, setSetting } from "./write";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

const NOW = new Date("2026-03-07T12:00:00Z");
const ADMIN: StaffActor = { kind: "admin", label: null };

// Settings for staff (M8 Task 13): the editable keys, checked by their
// schemas, audited with before and after.
describe("setSetting (M8 Task 13)", () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.close();
  });

  const nothingWritten = async () => {
    expect(await t.db.select().from(settings)).toEqual([]);
    expect(await t.db.select().from(auditLog)).toEqual([]);
  };

  it("the editable keys are the flags, the poll schedule and the finalizer checks", () => {
    expect([...EDITABLE_SETTINGS]).toEqual([
      "feature_flags",
      "poll_schedule",
      "finalizer_checks",
    ]);
  });

  it("feature_flags defaults to chat and push on", async () => {
    expect(await getSetting(t.db, "feature_flags")).toEqual({
      chat: true,
      push: true,
    });
  });

  it("setSetting turns chat off with the audit before and after", async () => {
    const done = await setSetting(t.db, NOW, ADMIN, {
      key: "feature_flags",
      value: { chat: false, push: true },
      reason: "Chat is flooding",
    });
    expect(done).toEqual({ changed: true });
    expect(await getSetting(t.db, "feature_flags")).toEqual({
      chat: false,
      push: true,
    });
    const [row] = await t.db.select().from(auditLog);
    expect(row).toMatchObject({
      action: "setting.update",
      entityType: "setting",
      reason: "Chat is flooding",
      before: { chat: "On" },
      after: { chat: "Off" },
    });
  });

  it("setSetting refuses a value its schema refuses, with invalid, nothing written", async () => {
    await expect(
      setSetting(t.db, NOW, ADMIN, {
        key: "feature_flags",
        value: { chat: "no" },
        reason: "Testing",
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    await nothingWritten();
  });

  it("setSetting refuses an empty poll schedule and a finalizer check of 0", async () => {
    await expect(
      setSetting(t.db, NOW, ADMIN, {
        key: "poll_schedule",
        value: { backoffMinutes: [], giveUpAfterHours: 24 },
        reason: "Testing",
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    await expect(
      setSetting(t.db, NOW, ADMIN, {
        key: "finalizer_checks",
        value: { afterHours: [0, 6] },
        reason: "Testing",
      }),
    ).rejects.toMatchObject({ code: "invalid" });
    await nothingWritten();
  });

  it("setSetting with an unchanged value writes nothing", async () => {
    const done = await setSetting(t.db, NOW, ADMIN, {
      key: "poll_schedule",
      value: { backoffMinutes: [5, 15, 60], giveUpAfterHours: 24 },
      reason: "No change",
    });
    expect(done).toEqual({ changed: false });
    await nothingWritten();
  });

  it("a key outside EDITABLE_SETTINGS is refused with forbidden", async () => {
    await expect(
      setSetting(t.db, NOW, ADMIN, {
        key: "email_caps",
        value: { perDay: 1, perMonth: 1, reservedForUrgent: 0, alertAt: 0.5 },
        reason: "Testing",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await nothingWritten();
  });

  it("a blank reason is refused", async () => {
    await expect(
      setSetting(t.db, NOW, ADMIN, {
        key: "feature_flags",
        value: { chat: false, push: true },
        reason: "  ",
      }),
    ).rejects.toMatchObject({ code: "reason_required" });
    await nothingWritten();
  });

  it("a second change records only what changed", async () => {
    await setSetting(t.db, NOW, ADMIN, {
      key: "poll_schedule",
      value: { backoffMinutes: [5, 15, 60], giveUpAfterHours: 12 },
      reason: "Give up sooner",
    });
    const [row] = await t.db.select().from(auditLog);
    expect(row).toMatchObject({
      before: { giveUpAfterHours: 24 },
      after: { giveUpAfterHours: 12 },
    });
  });
});
