import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb } from "../../tests/helpers/test-db";
import { seedViewer } from "../../tests/helpers/community";
import { seedEventSessions } from "../../tests/helpers/sessions";
import {
  jobs,
  notificationPreferences,
  notifications,
  pushSubscriptions,
  settings,
} from "@/db/schema";
import type { Viewer } from "@/identity/viewer";
import { newId } from "@/lib/ids";
import {
  fanOut,
  subscribe,
  unsubscribe,
  type PushResult,
  type PushSender,
  type PushTarget,
} from "./push";
import { broadcast, notify } from "./write";

type TestDb = Awaited<ReturnType<typeof createTestDb>>;

const NOW = new Date("2026-06-08T12:00:00Z");

/** A push service that answers each endpoint as told, and keeps what it got. */
function fakeSender(answers: Record<string, PushResult> = {}) {
  const sent: { endpoint: string; payload: unknown }[] = [];
  const sender: PushSender = {
    async send(target: PushTarget, payload: string) {
      sent.push({ endpoint: target.endpoint, payload: JSON.parse(payload) });
      return answers[target.endpoint] ?? { ok: true };
    },
  };
  return { sender, sent };
}

describe("Web Push (DM 5.11)", () => {
  let t: TestDb;
  let fan: Viewer;

  beforeEach(async () => {
    t = await createTestDb();
    fan = await seedViewer(t.db, { username: "fan" });
  });

  afterEach(async () => {
    await t.close();
  });

  const device = (n: number, viewer = fan) =>
    subscribe(t.db, NOW, viewer, {
      endpoint: `https://push.example/${viewer.username}/${n}`,
      p256dh: `key${n}`,
      auth: `auth${n}`,
      userAgent: `Phone ${n}`,
    });
  const subs = () => t.db.select().from(pushSubscriptions);
  // A lock reminder: on for push unless turned off.
  const warned = () =>
    notify(t.db, NOW, {
      userId: fan.userId,
      kind: "lock_reminder",
      data: { event: "Monaco Grand Prix", hours: 24 },
    });

  it("three devices get three sends", async () => {
    await device(1);
    await device(2);
    await device(3);
    const id = await warned();
    const { sender, sent } = fakeSender();
    const done = await fanOut(t.db, sender, NOW, { notificationIds: [id!] });
    expect(sent).toHaveLength(3);
    expect(done).toMatchObject({ sent: 3, removed: 0, failed: 0 });
    expect(sent[0]!.payload).toMatchObject({
      title: "LOCK",
      body: "Monaco Grand Prix locks in 24 hours. Check your team.",
      url: "/team",
    });
    for (const sub of await subs()) expect(sub.lastSuccessAt).toEqual(NOW);
  });

  it("a 410 deletes the subscription", async () => {
    await device(1);
    await device(2);
    const id = await warned();
    const { sender } = fakeSender({
      "https://push.example/fan/1": { ok: false, status: 410 },
      "https://push.example/fan/2": { ok: false, status: 500 },
    });
    const done = await fanOut(t.db, sender, NOW, { notificationIds: [id!] });
    expect(done).toMatchObject({ sent: 0, removed: 1, failed: 1 });
    const left = await subs();
    expect(left.map((s) => s.endpoint)).toEqual(["https://push.example/fan/2"]);
    expect(left[0]!.failureCount).toBe(1);
  });

  it("a payload for a session's score never names a result", async () => {
    const ids = await seedEventSessions(
      t.db,
      new Date("2026-06-05T11:30:00Z"),
      new Date("2026-06-05T15:00:00Z"),
      new Date("2026-06-06T10:30:00Z"),
      new Date("2026-06-06T14:00:00Z"),
    );
    await device(1);
    const broadcastId = await broadcast(t.db, NOW, {
      kind: "scores_in",
      sessionId: ids[3]!,
      dedupeKey: `scores_in:${ids[3]}`,
      data: {
        event: "Monaco Grand Prix",
        session: "Qualifying",
        sessionKind: "qualifying",
        leader: "George Russell",
      },
    });
    const { sender, sent } = fakeSender();
    await fanOut(t.db, sender, NOW, { broadcastId: broadcastId! });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload).toMatchObject({
      body: "Qualifying results are in for the Monaco Grand Prix.",
    });
    expect(JSON.stringify(sent[0]!.payload)).not.toContain("Russell");
  });

  it("with no VAPID keys, fan-out sends nothing and logs a count", async () => {
    await device(1);
    await device(2);
    const id = await warned();
    const lines: string[] = [];
    const done = await fanOut(
      t.db,
      null,
      NOW,
      { notificationIds: [id!] },
      { log: (line) => lines.push(line) },
    );
    expect(done).toMatchObject({ sent: 0, skipped: 2 });
    expect(lines).toEqual(["push: no VAPID keys, 2 sends skipped"]);
    expect(await subs()).toHaveLength(2);
  });

  it("with push off, push_fanout sends nothing and in-app notifications are still written", async () => {
    await device(1);
    await t.db
      .insert(settings)
      .values({ key: "feature_flags", value: { chat: true, push: false } });
    const id = await warned();
    expect(id).toBeTruthy();
    expect(
      await t.db.select().from(notifications).where(eq(notifications.id, id!)),
    ).toHaveLength(1);
    const { sender, sent } = fakeSender();
    const done = await fanOut(t.db, sender, NOW, { notificationIds: [id!] });
    expect(sent).toHaveLength(0);
    expect(done).toMatchObject({ sent: 0 });
    // The device stays: push is only paused.
    expect(await subs()).toHaveLength(1);
  });

  it("a kind turned off for push sends nothing", async () => {
    await device(1);
    await t.db.insert(notificationPreferences).values({
      userId: fan.userId,
      kind: "lock_reminder",
      channel: "push",
      enabled: false,
    });
    const id = await warned();
    const { sender, sent } = fakeSender();
    await fanOut(t.db, sender, NOW, { notificationIds: [id!] });
    expect(sent).toHaveLength(0);
  });

  it("a notification queues a push job only for someone with a device", async () => {
    const pushJobs = () =>
      t.db.select().from(jobs).where(eq(jobs.kind, "push_fanout"));
    await warned();
    expect(await pushJobs()).toHaveLength(0);
    await device(1);
    await warned();
    expect(await pushJobs()).toHaveLength(1);
  });

  it("subscribing again from the same browser moves it, and unsubscribe removes it", async () => {
    await device(1);
    const other = await seedViewer(t.db, { username: "other" });
    await subscribe(t.db, NOW, other, {
      endpoint: "https://push.example/fan/1",
      p256dh: "new",
      auth: "new",
      userAgent: "Phone 1",
    });
    const [row] = await subs();
    expect(row).toMatchObject({ userId: other.userId, p256dh: "new" });
    await unsubscribe(t.db, fan, { endpoint: "https://push.example/fan/1" });
    expect(await subs()).toHaveLength(1); // not fan's any more
    await unsubscribe(t.db, other, { endpoint: "https://push.example/fan/1" });
    expect(await subs()).toHaveLength(0);
  });

  it("an account keeps its ten newest devices", async () => {
    for (let n = 1; n <= 12; n++) {
      await subscribe(t.db, new Date(NOW.getTime() + n * 1000), fan, {
        endpoint: `https://push.example/fan/${n}`,
        p256dh: `key${n}`,
        auth: `auth${n}`,
      });
    }
    const kept = (await subs()).map((r) => r.endpoint).sort();
    expect(kept).toHaveLength(10);
    expect(kept).not.toContain("https://push.example/fan/1");
    expect(kept).not.toContain("https://push.example/fan/2");
  });

  it("a broadcast to many devices goes 100 a job", async () => {
    // Straight into the table: `subscribe` keeps ten a person, and this is
    // about the batches.
    await t.db.insert(pushSubscriptions).values(
      Array.from({ length: 101 }, (_, i) => ({
        id: newId(),
        userId: fan.userId,
        endpoint: `https://push.example/fan/${i}`,
        p256dh: `key${i}`,
        auth: `auth${i}`,
        createdAt: NOW,
      })),
    );
    const broadcastId = await broadcast(t.db, NOW, {
      kind: "announcement",
      data: { text: "Welcome." },
    });
    // Announcements start off for push: turn it on for fan.
    await t.db.insert(notificationPreferences).values({
      userId: fan.userId,
      kind: "announcement",
      channel: "push",
      enabled: true,
    });
    const { sender, sent } = fakeSender();
    const first = await fanOut(t.db, sender, NOW, {
      broadcastId: broadcastId!,
    });
    expect(sent).toHaveLength(100);
    expect(first.next).toBeDefined();
    const second = await fanOut(t.db, sender, NOW, {
      broadcastId: broadcastId!,
      afterId: first.next!,
    });
    expect(sent).toHaveLength(101);
    expect(second.next).toBeUndefined();
  });
});
