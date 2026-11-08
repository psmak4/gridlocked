import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enqueue } from "@/jobs/queue";
import { createTestDb } from "../../../tests/helpers/test-db";
import {
  authRateLimits,
  emailOutbox,
  jobs,
  reviewItems,
  settings,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { newId } from "@/lib/ids";
import {
  createEmailFlushHandler,
  emailAllowance,
  flushEmail,
  queueEmail,
  URGENT_TEMPLATES,
} from "./outbox";
import type { EmailTemplate } from "./templates";
import { EmailCapError, EmailRejectedError, type EmailSender } from "./sender";

const NOW = new Date("2026-11-08T10:00:00Z");
const MIN = 60_000;
const LINK = "https://gridlocked.example/auth/go?token=first";

type Sent = Parameters<EmailSender["send"]>[0];

function fakeSender(
  behaviour: (m: Sent, n: number) => void | Promise<void> = () => {},
) {
  const sent: Sent[] = [];
  let calls = 0;
  const sender: EmailSender = {
    async send(m) {
      calls += 1;
      await behaviour(m, calls);
      sent.push(m);
      return { id: `msg_${sent.length}` };
    },
  };
  return { sender, sent, calls: () => calls };
}

describe("the email outbox", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let db: Db;
  beforeEach(async () => {
    t = await createTestDb();
    db = t.db as unknown as Db;
  });
  afterEach(async () => {
    await t.close();
  });

  /** `n` rows already sent at `at`, as if the day's allowance was used. */
  async function seedSent(n: number, at: Date) {
    const ts = at.toISOString();
    await db.execute(sql`
      insert into email_outbox (id, template, status, send_after, sent_at)
      select gen_random_uuid(), 'verify_email', 'sent', ${ts}::timestamptz, ${ts}::timestamptz
      from generate_series(1, ${n})`);
  }

  async function seedQueued(
    to: string,
    template: EmailTemplate,
    over: Partial<typeof emailOutbox.$inferInsert> = {},
  ) {
    const id = newId();
    await db.insert(emailOutbox).values({
      id,
      toEmail: to,
      template,
      payload: { url: LINK },
      sendAfter: NOW,
      createdAt: NOW,
      ...over,
    });
    return id;
  }

  const rows = () => db.select().from(emailOutbox);
  const queued = async () =>
    (await rows()).filter((r) => r.status === "queued");
  const request = (
    to: string,
    template: EmailTemplate = "verify_email",
    extra: { expiresAt?: Date } = {},
  ) => ({ to, template, payload: { url: LINK }, ...extra });

  describe("sending inside the call", () => {
    it("a normal email is sent inside the call", async () => {
      const f = fakeSender();
      const result = await queueEmail(
        db,
        NOW,
        request("ada@example.test"),
        f.sender,
      );
      expect(result).toEqual({ status: "sent" });
      expect(f.sent).toHaveLength(1);
      expect(f.sent[0]!.to).toBe("ada@example.test");
      expect(f.sent[0]!.text).toContain(LINK);
      const [row] = await rows();
      expect(row).toMatchObject({
        status: "sent",
        template: "verify_email",
        attempts: 1,
        providerMessageId: "msg_1",
        sentAt: NOW,
      });
      // The idempotency key is the outbox id.
      expect(f.sent[0]!.idempotencyKey).toBe(row!.id);
    });

    it("with no sender the row stays queued, and a flush job is queued", async () => {
      const result = await queueEmail(
        db,
        NOW,
        request("ada@example.test"),
        null,
      );
      expect(result).toEqual({ status: "queued" });
      expect(await queued()).toHaveLength(1);
      expect(await db.select().from(jobs)).toHaveLength(1);
    });
  });

  describe("the daily cap", () => {
    it("the 81st verification email of the day stays queued, and a magic link at the same moment still goes", async () => {
      await seedSent(80, new Date("2026-11-08T08:00:00Z"));
      const f = fakeSender();
      expect(
        await queueEmail(db, NOW, request("a@example.test"), f.sender),
      ).toEqual({ status: "queued" });
      expect(f.sent).toHaveLength(0);
      const [held] = await queued();
      expect(held!.sendAfter).toEqual(new Date("2026-11-09T00:00:00Z"));
      expect(
        await queueEmail(
          db,
          NOW,
          request("b@example.test", "magic_link"),
          f.sender,
        ),
      ).toEqual({ status: "sent" });
      expect(f.sent.map((m) => m.to)).toEqual(["b@example.test"]);
    });

    it("the 101st of any kind stays queued until the next UTC day", async () => {
      await seedSent(100, new Date("2026-11-08T08:00:00Z"));
      const f = fakeSender();
      for (const template of URGENT_TEMPLATES) {
        expect(
          await queueEmail(
            db,
            NOW,
            request(`${template}@example.test`, template),
            f.sender,
          ),
        ).toEqual({ status: "queued" });
      }
      expect(f.sent).toHaveLength(0);
      const held = await queued();
      expect(held).toHaveLength(3);
      for (const row of held) {
        expect(row.sendAfter).toEqual(new Date("2026-11-09T00:00:00Z"));
      }
      // The flush job is queued for that time.
      const [job] = await db.select().from(jobs);
      expect(job).toMatchObject({
        kind: "email_flush",
        dedupeKey: "email_flush:2026-11-09T00",
        runAt: new Date("2026-11-09T00:00:00Z"),
      });

      // Before then, nothing goes; after, everything does.
      const early = await flushEmail(
        db,
        new Date("2026-11-08T23:59:00Z"),
        f.sender,
        {},
      );
      expect(early.sent).toBe(0);
      const later = await flushEmail(
        db,
        new Date("2026-11-09T00:00:00Z"),
        f.sender,
        {},
      );
      expect(later).toMatchObject({ sent: 3, left: 0 });
    });

    it("the month's cap holds when the day has room", async () => {
      await seedSent(3000, new Date("2026-11-03T08:00:00Z"));
      const f = fakeSender();
      expect(
        await queueEmail(
          db,
          NOW,
          request("a@example.test", "magic_link"),
          f.sender,
        ),
      ).toEqual({ status: "queued" });
      expect(f.sent).toHaveLength(0);
      const [held] = await queued();
      expect(held!.sendAfter).toEqual(new Date("2026-12-01T00:00:00Z"));
      expect(await emailAllowance(db, NOW)).toMatchObject({
        usedToday: 0,
        usedThisMonth: 3000,
        busy: true,
      });
    });

    it("the allowance counts in UTC", async () => {
      await seedSent(100, new Date("2026-11-08T23:30:00Z"));
      await seedSent(3, new Date("2026-11-09T00:30:00Z"));
      expect(
        await emailAllowance(db, new Date("2026-11-09T01:00:00Z")),
      ).toEqual({
        usedToday: 3,
        usedThisMonth: 103,
        busy: false,
      });
      expect(
        await emailAllowance(db, new Date("2026-11-08T23:45:00Z")),
      ).toMatchObject({
        usedToday: 100,
        busy: true,
      });
      // A day in another month does not count for the month.
      await seedSent(5, new Date("2026-10-31T23:59:59Z"));
      expect((await emailAllowance(db, NOW)).usedThisMonth).toBe(103);
    });

    it("urgent rows leave first", async () => {
      await seedQueued("old@example.test", "verify_email", {
        createdAt: new Date(NOW.getTime() - 5 * MIN),
      });
      await seedQueued("new@example.test", "magic_link");
      const f = fakeSender();
      const result = await flushEmail(db, NOW, f.sender, {});
      expect(result).toMatchObject({ sent: 2, left: 0 });
      expect(f.sent.map((m) => m.to)).toEqual([
        "new@example.test",
        "old@example.test",
      ]);

      // With room for one, the urgent one is the one that goes.
      await seedQueued("old2@example.test", "verify_email", {
        createdAt: new Date(NOW.getTime() - 5 * MIN),
      });
      await seedQueued("new2@example.test", "password_reset");
      const g = fakeSender();
      const one = await flushEmail(db, NOW, g.sender, { limit: 1 });
      expect(one).toMatchObject({ sent: 1, left: 1 });
      expect(g.sent.map((m) => m.to)).toEqual(["new2@example.test"]);
    });

    it("asking again while queued replaces the row and spends nothing", async () => {
      await seedSent(80, new Date("2026-11-08T08:00:00Z"));
      const f = fakeSender();
      await queueEmail(db, NOW, request("Ada@Example.test"), f.sender);
      const [first] = await queued();
      const second = await queueEmail(
        db,
        new Date(NOW.getTime() + MIN),
        {
          ...request("ada@example.test"),
          payload: { url: "https://x.example/second" },
        },
        f.sender,
      );
      expect(second).toEqual({ status: "queued" });
      const held = await queued();
      expect(held).toHaveLength(1);
      expect(held[0]!.payload).toEqual({ url: "https://x.example/second" });
      expect(held[0]!.id).not.toBe(first!.id);
      expect(f.sent).toHaveLength(0);
      expect((await emailAllowance(db, NOW)).usedToday).toBe(80);
    });

    it("two calls at once can't both take the last place", async () => {
      await seedSent(79, new Date("2026-11-08T08:00:00Z"));
      const f = fakeSender(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      const results = await Promise.all([
        queueEmail(db, NOW, request("a@example.test"), f.sender),
        queueEmail(db, NOW, request("b@example.test"), f.sender),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual(["queued", "sent"]);
      expect(f.sent).toHaveLength(1);
      expect((await emailAllowance(db, NOW)).usedToday).toBe(80);
    });
  });

  describe("the per-address limit", () => {
    it("a fourth link to one address inside 10 minutes isn't sent, and spends nothing", async () => {
      const f = fakeSender();
      const statuses: string[] = [];
      for (let i = 0; i < 4; i++) {
        const r = await queueEmail(
          db,
          new Date(NOW.getTime() + i * MIN),
          request(
            i % 2 ? "ADA@example.test " : "ada@example.test",
            "magic_link",
          ),
          f.sender,
        );
        statuses.push(r.status);
      }
      expect(statuses).toEqual(["sent", "sent", "sent", "limited"]);
      expect(f.sent).toHaveLength(3);
      expect(await rows()).toHaveLength(3);
      expect((await emailAllowance(db, NOW)).usedToday).toBe(3);
      // After the window, it goes again.
      const later = await queueEmail(
        db,
        new Date(NOW.getTime() + 20 * MIN),
        request("ada@example.test", "magic_link"),
        f.sender,
      );
      expect(later.status).toBe("sent");
    });

    it("another template or address has its own limit", async () => {
      const f = fakeSender();
      for (let i = 0; i < 3; i++) {
        await queueEmail(
          db,
          NOW,
          request("ada@example.test", "magic_link"),
          f.sender,
        );
      }
      expect(
        await queueEmail(
          db,
          NOW,
          request("ada@example.test", "verify_email"),
          f.sender,
        ),
      ).toEqual({ status: "sent" });
      expect(
        await queueEmail(
          db,
          NOW,
          request("bob@example.test", "magic_link"),
          f.sender,
        ),
      ).toEqual({ status: "sent" });
    });

    it("the limit's key doesn't hold the address", async () => {
      const f = fakeSender();
      await queueEmail(db, NOW, request("Ada@Example.test "), f.sender);
      const keys = (await db.select().from(authRateLimits)).map((r) => r.key);
      const digest = createHash("sha256")
        .update("ada@example.test")
        .digest("hex");
      expect(keys).toContain(`email:verify_email:${digest}`);
      for (const key of keys) {
        expect(key.toLowerCase()).not.toContain("ada");
        expect(key).not.toContain("example");
      }
    });
  });

  describe("flushing", () => {
    it("a link past its expiry is marked expired, not sent", async () => {
      await seedQueued("a@example.test", "magic_link", {
        expiresAt: new Date(NOW.getTime() - MIN),
      });
      await seedQueued("b@example.test", "magic_link", {
        expiresAt: new Date(NOW.getTime() + 10 * MIN),
      });
      const f = fakeSender();
      const result = await flushEmail(db, NOW, f.sender, {});
      expect(result).toMatchObject({ sent: 1, expired: 1, failed: 0, left: 0 });
      expect(f.sent.map((m) => m.to)).toEqual(["b@example.test"]);
      expect((await rows()).map((r) => r.status).sort()).toEqual([
        "expired",
        "sent",
      ]);
    });

    it("a rejected address is failed and not retried", async () => {
      const f = fakeSender(() => {
        throw new EmailRejectedError();
      });
      const result = await queueEmail(
        db,
        NOW,
        request("bad@example.test"),
        f.sender,
      );
      expect(result).toEqual({ status: "failed" });
      const [row] = await rows();
      expect(row).toMatchObject({ status: "failed", attempts: 1 });
      const again = await flushEmail(
        db,
        new Date(NOW.getTime() + 2 * 3600_000),
        f.sender,
        {},
      );
      expect(again).toMatchObject({ sent: 0, failed: 0, left: 0 });
      expect(f.calls()).toBe(1);
    });

    it("a passing failure stays queued", async () => {
      const f = fakeSender(() => {
        throw new Error("Resend returned 500");
      });
      const result = await queueEmail(
        db,
        NOW,
        request("a@example.test"),
        f.sender,
      );
      expect(result).toEqual({ status: "queued" });
      const [row] = await queued();
      expect(row).toMatchObject({ attempts: 1, lastError: "send_failed" });
      expect(row!.sendAfter).toEqual(new Date("2026-11-08T11:00:00Z"));
      expect(row!.toEmail).toBe("a@example.test");
      const [job] = await db.select().from(jobs);
      expect(job).toMatchObject({
        dedupeKey: "email_flush:2026-11-08T11",
        runAt: new Date("2026-11-08T11:00:00Z"),
      });
      // The flush retries it, and a later success clears the row.
      const ok = fakeSender();
      const flushed = await flushEmail(
        db,
        new Date("2026-11-08T11:00:00Z"),
        ok.sender,
        {},
      );
      expect(flushed).toMatchObject({ sent: 1, left: 0 });
    });

    it("Resend's quota error stops the batch until tomorrow", async () => {
      await seedQueued("a@example.test", "magic_link");
      await seedQueued("b@example.test", "password_reset");
      await seedQueued("c@example.test", "verify_email");
      const f = fakeSender(() => {
        throw new EmailCapError();
      });
      const result = await flushEmail(db, NOW, f.sender, {});
      expect(result).toMatchObject({ sent: 0, failed: 0, left: 3 });
      expect(f.calls()).toBe(1);
      for (const row of await queued()) {
        expect(row.sendAfter).toEqual(new Date("2026-11-09T00:00:00Z"));
      }
      expect(result.retryAt).toEqual(new Date("2026-11-09T00:00:00Z"));
    });

    it("a finished row keeps no address and no link", async () => {
      // sent
      const ok = fakeSender();
      await queueEmail(db, NOW, request("sent@example.test"), ok.sender);
      // failed
      const bad = fakeSender(() => {
        throw new EmailRejectedError();
      });
      await queueEmail(
        db,
        NOW,
        request("failed@example.test", "magic_link"),
        bad.sender,
      );
      // expired
      await seedQueued("expired@example.test", "password_reset", {
        expiresAt: new Date(NOW.getTime() - MIN),
      });
      await flushEmail(db, NOW, ok.sender, {});

      const all = await rows();
      expect(all.map((r) => r.status).sort()).toEqual([
        "expired",
        "failed",
        "sent",
      ]);
      for (const row of all) {
        expect(row.toEmail).toBeNull();
        expect(row.payload).toEqual({});
        expect(row.template).toBeTruthy();
        expect(JSON.stringify(row)).not.toContain("example.test");
        expect(JSON.stringify(row)).not.toContain("token=");
      }
      expect(all.find((r) => r.status === "sent")!.sentAt).toEqual(NOW);
    });

    it("a flush run twice sends once", async () => {
      await seedQueued("a@example.test", "magic_link");
      const f = fakeSender();
      const [one, two] = [
        await flushEmail(db, NOW, f.sender, {}),
        await flushEmail(db, NOW, f.sender, {}),
      ];
      expect(one.sent).toBe(1);
      expect(two.sent).toBe(0);
      expect(f.sent).toHaveLength(1);
    });

    it("two flushes at once send once", async () => {
      await seedQueued("a@example.test", "magic_link");
      const f = fakeSender(async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      await Promise.all([
        flushEmail(db, NOW, f.sender, {}),
        flushEmail(db, NOW, f.sender, {}),
      ]);
      expect(f.sent).toHaveLength(1);
    });

    it("the flush job with no sender leaves rows queued, but expires old ones", async () => {
      await seedQueued("a@example.test", "magic_link");
      await seedQueued("b@example.test", "verify_email");
      await seedQueued("old@example.test", "password_reset", {
        expiresAt: new Date(NOW.getTime() - MIN),
      });
      const lines: string[] = [];
      const handler = createEmailFlushHandler(null, (l) => lines.push(l));
      const job = { id: "j", payload: {} } as Parameters<typeof handler>[0];
      await handler(job, { db, clock: { now: () => NOW } });
      expect(await queued()).toHaveLength(2);
      const gone = (await rows()).find((r) => r.status === "expired");
      expect(gone).toMatchObject({ toEmail: null, payload: {} });
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("2");
      expect(lines[0]).not.toContain("example.test");
    });

    it("the flush job sends what is due and queues the next flush for what is left", async () => {
      await seedSent(80, new Date("2026-11-08T08:00:00Z"));
      await seedQueued("a@example.test", "verify_email");
      await seedQueued("b@example.test", "magic_link");
      const f = fakeSender();
      const handler = createEmailFlushHandler(f.sender, () => {});
      const job = { id: "j", payload: {} } as Parameters<typeof handler>[0];
      await handler(job, { db, clock: { now: () => NOW } });
      expect(f.sent.map((m) => m.to)).toEqual(["b@example.test"]);
      const [next] = await db.select().from(jobs);
      expect(next).toMatchObject({
        kind: "email_flush",
        runAt: new Date("2026-11-09T00:00:00Z"),
      });
    });
  });

  describe("bounds and boundaries", () => {
    it("a verify_email row with no expiresAt is expired and scrubbed after 24 hours, not sent", async () => {
      await queueEmail(db, NOW, request("a@example.test"), null);
      const [row] = await queued();
      expect(row!.expiresAt).toEqual(new Date(NOW.getTime() + 24 * 3600_000));
      const f = fakeSender();
      const later = new Date(NOW.getTime() + 24 * 3600_000);
      const result = await flushEmail(db, later, f.sender, {});
      expect(result).toMatchObject({ sent: 0, expired: 1, left: 0 });
      expect(f.calls()).toBe(0);
      const [done] = await rows();
      expect(done).toMatchObject({
        status: "expired",
        toEmail: null,
        payload: {},
      });
    });

    it("an urgent email goes at 99 sent today and is queued at 100", async () => {
      await seedSent(99, new Date("2026-11-08T08:00:00Z"));
      const f = fakeSender();
      expect(
        await queueEmail(
          db,
          NOW,
          request("a@example.test", "magic_link"),
          f.sender,
        ),
      ).toEqual({ status: "sent" });
      expect(
        await queueEmail(
          db,
          NOW,
          request("b@example.test", "magic_link"),
          f.sender,
        ),
      ).toEqual({ status: "queued" });
    });

    it("the month's cap goes from 2999 to 3000", async () => {
      await seedSent(2999, new Date("2026-11-03T08:00:00Z"));
      const f = fakeSender();
      expect(
        await queueEmail(
          db,
          NOW,
          request("a@example.test", "magic_link"),
          f.sender,
        ),
      ).toEqual({ status: "sent" });
      expect(
        await queueEmail(
          db,
          NOW,
          request("b@example.test", "magic_link"),
          f.sender,
        ),
      ).toEqual({ status: "queued" });
    });

    it("a retry after a passing failure uses the same Idempotency-Key", async () => {
      const keys: string[] = [];
      const f = fakeSender((m, n) => {
        keys.push(m.idempotencyKey);
        if (n === 1) throw new Error("boom");
      });
      await queueEmail(db, NOW, request("a@example.test"), f.sender);
      await flushEmail(db, new Date("2026-11-08T11:00:00Z"), f.sender, {});
      expect(keys).toHaveLength(2);
      expect(keys[1]).toBe(keys[0]);
    });

    it("a sent email stays sent when the cap alert breaks", async () => {
      await seedSent(79, new Date("2026-11-08T08:00:00Z"));
      await db.execute(
        sql`alter table review_items rename to review_items_gone`,
      );
      const f = fakeSender();
      const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect(
          await queueEmail(
            db,
            NOW,
            request("a@example.test", "magic_link"),
            f.sender,
          ),
        ).toEqual({ status: "sent" });
        expect(quiet).toHaveBeenCalledWith(
          "email outbox: the cap alert could not be checked",
        );
        expect(JSON.stringify(quiet.mock.calls)).not.toContain("example.test");
      } finally {
        quiet.mockRestore();
      }
    });
  });

  describe("the next flush", () => {
    it("a batch that hit its limit schedules the next flush within a minute, even when this hour's job is done", async () => {
      for (let i = 0; i < 3; i++) {
        await seedQueued(`u${i}@example.test`, "magic_link");
      }
      // This hour's flush job is the one now running.
      await enqueue(db, {
        kind: "email_flush",
        dedupeKey: "email_flush:2026-11-08T10",
        runAt: new Date("2026-11-08T10:00:00Z"),
        payload: {},
      });
      await db.update(jobs).set({ status: "succeeded" });
      const f = fakeSender();
      const handler = createEmailFlushHandler(f.sender, () => {}, { limit: 2 });
      const job = { id: "j", payload: {} } as Parameters<typeof handler>[0];
      const at = new Date("2026-11-08T10:03:30Z");
      await handler(job, { db, clock: { now: () => at } });
      expect(f.sent).toHaveLength(2);
      const pending = (await db.select().from(jobs)).filter(
        (j) => j.status === "pending",
      );
      expect(pending).toHaveLength(1);
      expect(pending[0]!.runAt).toEqual(new Date("2026-11-08T10:04:00Z"));
      // And that flush sends the last one.
      await handler(job, {
        db,
        clock: { now: () => pending[0]!.runAt },
      });
      expect(f.sent).toHaveLength(3);
    });

    it("a queued row always has a live flush job in a future hour", async () => {
      const f = fakeSender(() => {
        throw new Error("boom");
      });
      await queueEmail(db, NOW, request("a@example.test"), f.sender);
      const live = (await db.select().from(jobs)).filter(
        (j) => j.status === "pending" && j.runAt > NOW,
      );
      expect(live).toHaveLength(1);
    });
  });

  describe("the 80% review item", () => {
    const items = () =>
      db
        .select()
        .from(reviewItems)
        .where(eq(reviewItems.kind, "email_cap_near"));

    it("opens once a day", async () => {
      await seedSent(78, new Date("2026-11-08T08:00:00Z"));
      const f = fakeSender();
      await queueEmail(
        db,
        NOW,
        request("a@example.test", "magic_link"),
        f.sender,
      );
      expect(await items()).toHaveLength(0); // 79 used
      await queueEmail(
        db,
        NOW,
        request("b@example.test", "magic_link"),
        f.sender,
      );
      const [item] = await items();
      expect(item).toMatchObject({
        status: "open",
        severity: "warning",
        dedupeKey: "email_cap_near:2026-11-08",
        seasonId: null,
      });
      expect(item!.details).toEqual({ usedToday: 80, perDay: 100 });

      // More emails, and even a resolved item, don't open another that day.
      await db.update(reviewItems).set({ status: "resolved" });
      await queueEmail(
        db,
        NOW,
        request("c@example.test", "magic_link"),
        f.sender,
      );
      expect(await items()).toHaveLength(1);

      // The next day it can open again.
      const tomorrow = new Date("2026-11-09T09:00:00Z");
      await seedSent(80, new Date("2026-11-09T08:00:00Z"));
      await queueEmail(
        db,
        tomorrow,
        request("d@example.test", "magic_link"),
        f.sender,
      );
      expect(await items()).toHaveLength(2);
    });
  });

  describe("settings", () => {
    it("reads the caps from the email_caps setting", async () => {
      await db.insert(settings).values({
        key: "email_caps",
        value: {
          perDay: 10,
          perMonth: 3000,
          reservedForUrgent: 5,
          alertAt: 0.8,
        },
      } as typeof settings.$inferInsert);
      await seedSent(5, new Date("2026-11-08T08:00:00Z"));
      const f = fakeSender();
      expect(
        await queueEmail(db, NOW, request("a@example.test"), f.sender),
      ).toEqual({ status: "queued" });
      expect(
        await queueEmail(
          db,
          NOW,
          request("b@example.test", "magic_link"),
          f.sender,
        ),
      ).toEqual({ status: "sent" });
    });
  });
});
