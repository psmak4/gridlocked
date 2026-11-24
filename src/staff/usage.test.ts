import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import {
  emailOutbox,
  jobs,
  notifications,
  pushSubscriptions,
  reviewItems,
  usageSnapshots,
} from "@/db/schema";
import { seedUser } from "../../tests/helpers/users";
import { newId } from "@/lib/ids";
import { recordUsage, usageMeters, USAGE_LIMITS } from "./usage";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

const NOW = new Date("2026-03-07T05:00:00Z");

// Free-tier usage (M8 Task 14): the daily snapshot, its 70% warnings, and
// the meters the settings screen shows.
describe("recordUsage and usageMeters (M8 Task 14)", () => {
  let t: TestDb;

  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.close();
  });

  const warnings = () =>
    t.db.select().from(reviewItems).where(eq(reviewItems.kind, "usage_high"));

  it("recordUsage at 74% compute opens one usage_high warning, and a second snapshot the same month opens none", async () => {
    await recordUsage(t.db, NOW, {
      neonComputeHours: 74,
      neonTransferGb: 1,
      vercelCpuHours: 0.5,
    });
    const first = await warnings();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      severity: "warning",
      details: { meter: "neon_compute", value: 74, limit: 100 },
    });

    await recordUsage(t.db, new Date("2026-03-08T05:00:00Z"), {
      neonComputeHours: 80,
      neonTransferGb: 1,
      vercelCpuHours: 0.5,
    });
    expect(await warnings()).toHaveLength(1);
    expect(await t.db.select().from(usageSnapshots)).toHaveLength(2);

    // A new month warns again.
    await recordUsage(t.db, new Date("2026-04-02T05:00:00Z"), {
      neonComputeHours: 71,
      neonTransferGb: 1,
      vercelCpuHours: 0.5,
    });
    expect(await warnings()).toHaveLength(2);
  });

  it("recordUsage keeps the limits it was measured against", async () => {
    await recordUsage(t.db, NOW, {
      neonComputeHours: 10,
      neonTransferGb: 1,
      vercelCpuHours: null,
    });
    const [row] = await t.db.select().from(usageSnapshots);
    expect(row).toMatchObject({ vercelCpuHours: null, limits: USAGE_LIMITS });
    expect(await warnings()).toHaveLength(0);
  });

  it("usageMeters says No reading yet before the first snapshot", async () => {
    const meters = await usageMeters(t.db, NOW);
    expect(meters.map((m) => m.label)).toEqual([
      "Neon compute",
      "Neon transfer",
      "Vercel function CPU",
      "Account emails today",
    ]);
    expect(meters[0]).toMatchObject({
      value: null,
      note: "No reading yet",
      warn: false,
    });
  });

  it("usageMeters shows Fine under 70% and the board's warning over it", async () => {
    await recordUsage(t.db, NOW, {
      neonComputeHours: 74,
      neonTransferGb: 1.5,
      vercelCpuHours: null,
    });
    const [compute, transfer, cpu] = await usageMeters(t.db, NOW);
    expect(compute).toMatchObject({
      value: "74 of 100 CU-hours",
      pct: 74,
      warn: true,
      note: "Over 70%: plan to upgrade before it runs out",
    });
    expect(transfer).toMatchObject({
      value: "1.5 of 5 GB",
      pct: 30,
      warn: false,
      note: "Fine",
    });
    expect(cpu).toMatchObject({
      value: null,
      warn: false,
      note: "No reading from Vercel",
    });
  });

  it("the email meter counts today's sent and queued account emails against email_caps", async () => {
    const row = (
      status: "sent" | "queued" | "failed",
      sentAt: Date | null,
    ) => ({
      id: newId(),
      // A queued row still holds its address; a finished one is scrubbed.
      toEmail: status === "queued" ? "fan@example.test" : null,
      template: "magic_link" as const,
      status,
      sendAfter: NOW,
      sentAt,
      createdAt: NOW,
    });
    await t.db.insert(emailOutbox).values([
      row("sent", new Date("2026-03-07T01:00:00Z")),
      row("sent", new Date("2026-03-07T04:00:00Z")),
      // Yesterday's doesn't count.
      row("sent", new Date("2026-03-06T23:00:00Z")),
      row("queued", null),
      row("failed", null),
    ]);
    const meters = await usageMeters(t.db, NOW);
    expect(meters.at(-1)).toMatchObject({
      label: "Account emails today",
      value: "3 of 100",
      pct: 3,
      warn: false,
      note: "Fine",
    });
  });

  it("a usage_high item pushes to every admin with push on, once per meter per day", async () => {
    const admin = await seedUser(t.db, { role: "admin" });
    const quiet = await seedUser(t.db, { role: "admin" });
    const moderator = await seedUser(t.db, { role: "moderator" });
    await t.db.insert(pushSubscriptions).values(
      [admin, moderator].map((userId) => ({
        id: newId(),
        userId,
        endpoint: `https://push.example/${userId}`,
        p256dh: "key",
        auth: "auth",
        createdAt: NOW,
      })),
    );
    const high = {
      neonComputeHours: 74,
      neonTransferGb: 1,
      vercelCpuHours: 0.5,
    };
    const alerts = () =>
      t.db
        .select()
        .from(notifications)
        .where(eq(notifications.kind, "usage_high"));
    const pushes = () =>
      t.db.select().from(jobs).where(eq(jobs.kind, "push_fanout"));

    await recordUsage(t.db, NOW, high);
    // Every admin has it in the bell; only the one with a device is pushed.
    expect((await alerts()).map((n) => n.userId).sort()).toEqual(
      [admin, quiet].sort(),
    );
    expect(await alerts()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          data: expect.objectContaining({ meter: "Neon compute", pct: 74 }),
        }),
      ]),
    );
    expect(await pushes()).toHaveLength(1);

    // A second run the same day: nothing new.
    await recordUsage(t.db, new Date("2026-03-07T09:00:00Z"), high);
    expect(await alerts()).toHaveLength(2);
    expect(await pushes()).toHaveLength(1);

    // The next day, still over and still open: once more.
    await recordUsage(t.db, new Date("2026-03-08T05:00:00Z"), high);
    expect(await alerts()).toHaveLength(4);
    expect(await pushes()).toHaveLength(2);

    // Resolved: no more alerts for it this month.
    await t.db
      .update(reviewItems)
      .set({ status: "resolved" })
      .where(eq(reviewItems.kind, "usage_high"));
    await recordUsage(t.db, new Date("2026-03-09T05:00:00Z"), high);
    expect(await alerts()).toHaveLength(4);
  });
});
