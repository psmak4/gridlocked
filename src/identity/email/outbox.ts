/**
 * The email outbox (DM 5.11, HLD §10): account emails go through a table so
 * the free plan's caps (100 a day, 3,000 a month) delay mail instead of
 * losing it.
 *
 * - Every function takes `now` from its caller.
 * - The allowance check and the send-or-queue decision run in a transaction
 *   that holds a Postgres advisory lock, so two calls can't both take the last
 *   place. The send happens inside it; the row is marked `sent` before the
 *   lock is released. If the process dies between Resend and the update, the
 *   row is still queued and the retry carries the same idempotency key (the
 *   outbox id), so Resend does not send it twice.
 * - Nothing personal is logged or stored in an error: `last_error` holds a
 *   short code, and a finished row (`sent`, `failed`, `expired`) drops its
 *   address and payload.
 */
import { createHash } from "node:crypto";
import { and, asc, eq, lte, or, sql } from "drizzle-orm";
import { emailOutbox, reviewItems } from "@/db/schema";
import type { Db } from "@/db/types";
import { emailFlushKey } from "@/jobs/kinds";
import { enqueue } from "@/jobs/queue";
import type { JobHandler } from "@/jobs/runner";
import { newId } from "@/lib/ids";
import { openReviewItem } from "@/reference/review";
import { getSetting, type SettingValue } from "@/settings";
import { consumeRateLimit } from "../viewer";
import { EmailCapError, EmailRejectedError, type EmailSender } from "./sender";
import {
  renderEmail,
  type EmailPayload,
  type EmailTemplate,
} from "./templates";

/** Magic links, resets and delete confirmations expire, so they go first. */
export const URGENT_TEMPLATES: readonly EmailTemplate[] = [
  "magic_link",
  "password_reset",
  "delete_confirm",
];
const isUrgent = (template: EmailTemplate) =>
  URGENT_TEMPLATES.includes(template);

/** Better Auth limits by IP; this limits by address: 3 per template in 10 minutes. */
const ADDRESS_LIMIT = { windowSeconds: 600, max: 3 };

/** Every row expires: a retry can't outlive Resend's idempotency window (~24 h). */
const DEFAULT_LIFETIME_MS = 24 * 3_600_000;

/** The advisory lock every allowance decision takes (transaction-scoped). */
const OUTBOX_LOCK = 481_516_234_201;

type Caps = SettingValue<"email_caps">;
type Row = typeof emailOutbox.$inferSelect;
type Outcome = "sent" | "failed" | "expired" | "held" | "retry" | "cap";

// --- UTC time ---------------------------------------------------------------

const startOfDay = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const startOfNextDay = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
const startOfMonth = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const startOfNextMonth = (d: Date) =>
  new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
/** The start of the next UTC hour: later than `d`, and in a different flush key. */
const startOfNextHour = (d: Date) =>
  new Date((Math.floor(d.getTime() / 3_600_000) + 1) * 3_600_000);

/** The next whole minute: soon, but never the instant the flush is running. */
const startOfNextMinute = (d: Date) =>
  new Date((Math.floor(d.getTime() / 60_000) + 1) * 60_000);

// --- The allowance ----------------------------------------------------------

const iso = (d: Date) => d.toISOString();

async function used(
  db: Db,
  now: Date,
): Promise<{ usedToday: number; usedThisMonth: number }> {
  const monthStart = startOfMonth(now);
  const monthEnd = startOfNextMonth(now);
  const dayStart = startOfDay(now);
  const dayEnd = startOfNextDay(now);
  const [row] = await db
    .select({
      today: sql<number>`(count(*) filter (where ${emailOutbox.sentAt} >= ${iso(dayStart)}::timestamptz and ${emailOutbox.sentAt} < ${iso(dayEnd)}::timestamptz))::int`,
      month: sql<number>`count(*)::int`,
    })
    .from(emailOutbox)
    .where(
      and(
        eq(emailOutbox.status, "sent"),
        sql`${emailOutbox.sentAt} >= ${iso(monthStart)}::timestamptz and ${emailOutbox.sentAt} < ${iso(monthEnd)}::timestamptz`,
      ),
    );
  return { usedToday: row?.today ?? 0, usedThisMonth: row?.month ?? 0 };
}

/**
 * What the caps have left, counted in UTC from `sent_at`. `busy` is true when
 * an ordinary email would wait (the non-urgent share of the day, or the month,
 * is used up); it drives "It might take a while today".
 */
export async function emailAllowance(
  db: Db,
  now: Date,
): Promise<{ usedToday: number; usedThisMonth: number; busy: boolean }> {
  const caps = await getSetting(db, "email_caps");
  const counts = await used(db, now);
  return {
    ...counts,
    busy:
      counts.usedToday >= caps.perDay - caps.reservedForUrgent ||
      counts.usedThisMonth >= caps.perMonth,
  };
}

/** Null if `template` may go now, else when the allowance next opens. */
function blockedUntil(
  caps: Caps,
  template: EmailTemplate,
  counts: { usedToday: number; usedThisMonth: number },
  now: Date,
): Date | null {
  if (counts.usedThisMonth >= caps.perMonth) return startOfNextMonth(now);
  const dayLimit = isUrgent(template)
    ? caps.perDay
    : caps.perDay - caps.reservedForUrgent;
  if (counts.usedToday >= dayLimit) return startOfNextDay(now);
  return null;
}

/** The alert is a nicety: if it fails, a sent email must not turn into an error. */
async function alertSafely(db: Db, now: Date, caps: Caps): Promise<void> {
  try {
    await alertIfNear(db, now, caps);
  } catch {
    console.error("email outbox: the cap alert could not be checked");
  }
}

/** Opens `email_cap_near` once per UTC day, even if an admin resolved it. */
async function alertIfNear(db: Db, now: Date, caps: Caps): Promise<void> {
  const { usedToday } = await used(db, now);
  if (usedToday < Math.ceil(caps.perDay * caps.alertAt - 1e-9)) return;
  const dedupeKey = `email_cap_near:${iso(now).slice(0, 10)}`;
  const [seen] = await db
    .select({ id: reviewItems.id })
    .from(reviewItems)
    .where(eq(reviewItems.dedupeKey, dedupeKey));
  if (seen) return;
  await openReviewItem(db, now, {
    kind: "email_cap_near",
    seasonId: null,
    details: { usedToday, perDay: caps.perDay },
    dedupeKey,
  });
}

// --- Sending one row --------------------------------------------------------

/** What a finished row keeps: its template, status and timestamps, nothing personal. */
const SCRUBBED = { toEmail: null, payload: {} } as const;

/**
 * Decides and sends one queued row. Caller holds the outbox lock, inside a
 * transaction, and has read `row` under it.
 */
async function attempt(
  tx: Db,
  now: Date,
  row: Row,
  sender: EmailSender,
  caps: Caps,
): Promise<{ outcome: Outcome; sendAfter?: Date }> {
  if (row.expiresAt && row.expiresAt <= now) {
    await tx
      .update(emailOutbox)
      .set({ ...SCRUBBED, status: "expired" })
      .where(eq(emailOutbox.id, row.id));
    return { outcome: "expired" };
  }

  const until = blockedUntil(caps, row.template, await used(tx, now), now);
  if (until) {
    await tx
      .update(emailOutbox)
      .set({ sendAfter: until })
      .where(eq(emailOutbox.id, row.id));
    return { outcome: "held", sendAfter: until };
  }

  const attempts = row.attempts + 1;
  try {
    const { subject, text, html } = renderEmail(
      row.template,
      row.payload as EmailPayload,
    );
    const { id } = await sender.send({
      idempotencyKey: row.id,
      to: row.toEmail!,
      subject,
      text,
      html,
    });
    await tx
      .update(emailOutbox)
      .set({
        ...SCRUBBED,
        status: "sent",
        sentAt: now,
        providerMessageId: id,
        attempts,
        lastError: null,
      })
      .where(eq(emailOutbox.id, row.id));
    return { outcome: "sent" };
  } catch (error) {
    if (error instanceof EmailRejectedError) {
      await tx
        .update(emailOutbox)
        .set({ ...SCRUBBED, status: "failed", attempts, lastError: "rejected" })
        .where(eq(emailOutbox.id, row.id));
      return { outcome: "failed" };
    }
    if (error instanceof EmailCapError) {
      // The provider's quota is used up: hold everything that is due.
      const tomorrow = startOfNextDay(now);
      await tx
        .update(emailOutbox)
        .set({ sendAfter: tomorrow })
        .where(
          and(
            eq(emailOutbox.status, "queued"),
            lte(emailOutbox.sendAfter, now),
          ),
        );
      await tx
        .update(emailOutbox)
        .set({ attempts, lastError: "provider_cap" })
        .where(eq(emailOutbox.id, row.id));
      return { outcome: "cap", sendAfter: tomorrow };
    }
    // A passing failure: try again in the next hour. Only a fixed code is kept.
    const next = startOfNextHour(now);
    await tx
      .update(emailOutbox)
      .set({ sendAfter: next, attempts, lastError: "send_failed" })
      .where(eq(emailOutbox.id, row.id));
    return { outcome: "retry", sendAfter: next };
  }
}

// --- Queueing ---------------------------------------------------------------

const addressKey = (template: EmailTemplate, to: string) =>
  `email:${template}:${createHash("sha256")
    .update(to.trim().toLowerCase(), "utf8")
    .digest("hex")}`;

/**
 * Queues an account email and sends it at once if the allowance has room.
 *
 * First the per-address limit (3 per address and template in 10 minutes, on a
 * hash of the address): past it, nothing is written and `limited` comes back,
 * which no caller shows, so a stranger can't tell. Then the queued row is
 * upserted (a repeat while queued replaces it) and sent under the outbox lock.
 * Over the cap, with no sender, or on a passing failure, the row stays
 * `queued` with `send_after` and an `email_flush` job is queued for then.
 */
export async function queueEmail(
  db: Db,
  now: Date,
  email: {
    to: string;
    template: EmailTemplate;
    payload: EmailPayload;
    expiresAt?: Date;
  },
  sender: EmailSender | null,
): Promise<{ status: "sent" | "queued" | "failed" | "limited" }> {
  const to = email.to.trim();
  const within = await consumeRateLimit(
    db,
    now,
    addressKey(email.template, to),
    ADDRESS_LIMIT,
  );
  if (!within) return { status: "limited" };

  const caps = await getSetting(db, "email_caps");
  const status = await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    await t.execute(
      sql`select pg_advisory_xact_lock(${sql.raw(String(OUTBOX_LOCK))})`,
    );

    const id = newId();
    // The partial unique index is the conflict target; a repeat replaces the
    // queued row (with a new id and so a new idempotency key, since the
    // payload differs) and does not touch `created_at`.
    await t.execute(sql`
      insert into email_outbox (id, to_email, template, payload, status, attempts, send_after, expires_at)
      values (${id}, ${to}, ${email.template}, ${JSON.stringify(email.payload)}::jsonb, 'queued', 0, ${iso(now)}::timestamptz, ${iso(email.expiresAt ?? new Date(now.getTime() + DEFAULT_LIFETIME_MS))}::timestamptz)
      on conflict (lower(to_email), template) where status = 'queued'
      do update set id = excluded.id, to_email = excluded.to_email, payload = excluded.payload,
        attempts = 0, last_error = null, send_after = excluded.send_after, expires_at = excluded.expires_at`);
    const [row] = await t
      .select()
      .from(emailOutbox)
      .where(eq(emailOutbox.id, id));
    if (!row) throw new Error("email outbox: the queued row vanished");

    let result: { status: "sent" | "queued" | "failed" };
    let flushAt: Date | null = null;
    if (!sender) {
      result = { status: "queued" };
      flushAt = startOfNextHour(now);
    } else {
      const { outcome, sendAfter } = await attempt(t, now, row, sender, caps);
      result = {
        status:
          outcome === "sent"
            ? "sent"
            : outcome === "failed" || outcome === "expired"
              ? "failed"
              : "queued",
      };
      flushAt = sendAfter ?? null;
    }
    if (flushAt) {
      await enqueue(t, {
        kind: "email_flush",
        dedupeKey: emailFlushKey(flushAt),
        runAt: flushAt,
        payload: {},
      });
    }
    return result.status;
  });

  if (status === "sent") await alertSafely(db, now, caps);
  return { status };
}

// --- Flushing ---------------------------------------------------------------

/**
 * Sends what is due: urgent templates first, then oldest. A row past its
 * `expires_at` is marked `expired`, not sent. Each row takes the outbox lock
 * in its own transaction and is re-read under it, so two flushes at once (or a
 * replaced row) send once. A provider quota error stops the batch.
 * `retryAt` is when the next flush should run, if rows are left.
 */
export async function flushEmail(
  db: Db,
  now: Date,
  sender: EmailSender,
  { limit = 50 }: { limit?: number },
): Promise<{
  sent: number;
  expired: number;
  failed: number;
  left: number;
  retryAt: Date | null;
}> {
  const caps = await getSetting(db, "email_caps");
  const due = await db
    .select({ id: emailOutbox.id })
    .from(emailOutbox)
    .where(
      and(
        eq(emailOutbox.status, "queued"),
        or(lte(emailOutbox.sendAfter, now), lte(emailOutbox.expiresAt, now)),
      ),
    )
    .orderBy(
      sql`(${emailOutbox.template} in (${sql.join(
        URGENT_TEMPLATES.map((t) => sql`${t}`),
        sql`, `,
      )})) desc`,
      asc(emailOutbox.createdAt),
      asc(emailOutbox.id),
    )
    .limit(limit);

  const result = { sent: 0, expired: 0, failed: 0 };
  for (const { id } of due) {
    const outcome = await db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      await t.execute(
        sql`select pg_advisory_xact_lock(${sql.raw(String(OUTBOX_LOCK))})`,
      );
      const [row] = await t
        .select()
        .from(emailOutbox)
        .where(and(eq(emailOutbox.id, id), eq(emailOutbox.status, "queued")));
      // Gone (sent by another flush, replaced) or not yet due again.
      if (!row) return null;
      const expired = row.expiresAt !== null && row.expiresAt <= now;
      if (!expired && row.sendAfter > now) return null;
      return (await attempt(t, now, row, sender, caps)).outcome;
    });
    if (outcome === "sent") result.sent += 1;
    else if (outcome === "expired") result.expired += 1;
    else if (outcome === "failed") result.failed += 1;
    else if (outcome === "cap") break;
  }

  const remaining = await db
    .select({ sendAfter: emailOutbox.sendAfter })
    .from(emailOutbox)
    .where(eq(emailOutbox.status, "queued"));
  let retryAt: Date | null = null;
  for (const { sendAfter } of remaining) {
    // Due rows still here means the batch hit its limit: go again soon.
    const at = sendAfter > now ? sendAfter : startOfNextMinute(now);
    if (!retryAt || at < retryAt) retryAt = at;
  }
  if (result.sent > 0) await alertSafely(db, now, caps);
  return { ...result, left: remaining.length, retryAt };
}

/**
 * Marks queued rows past `expires_at` as `expired` and scrubs them. Needs no
 * sender, so a flush with Resend not set up still bounds how long an address
 * is kept. Returns how many it expired.
 */
export async function expireEmail(db: Db, now: Date): Promise<number> {
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    await t.execute(
      sql`select pg_advisory_xact_lock(${sql.raw(String(OUTBOX_LOCK))})`,
    );
    const rows = await t
      .update(emailOutbox)
      .set({ ...SCRUBBED, status: "expired" })
      .where(
        and(eq(emailOutbox.status, "queued"), lte(emailOutbox.expiresAt, now)),
      )
      .returning({ id: emailOutbox.id });
    return rows.length;
  });
}

/**
 * The `email_flush` handler. With no sender (Resend not set up yet) it leaves
 * the rows queued and logs only a count. Otherwise it flushes and queues the
 * next flush for what is left.
 */
export function createEmailFlushHandler(
  sender: EmailSender | null,
  log: (line: string) => void = console.log,
  { limit }: { limit?: number } = {},
): JobHandler {
  return async (_job, ctx) => {
    const db = ctx.db as Db;
    const now = ctx.clock.now();
    if (!sender) {
      const expired = await expireEmail(db, now);
      const queued = await db
        .select({ id: emailOutbox.id })
        .from(emailOutbox)
        .where(eq(emailOutbox.status, "queued"));
      log(
        `email_flush: no sender configured, ${queued.length} queued, ${expired} expired`,
      );
      return;
    }
    const { retryAt, ...counts } = await flushEmail(db, now, sender, { limit });
    if (retryAt) {
      await enqueue(db, {
        kind: "email_flush",
        dedupeKey: emailFlushKey(retryAt),
        runAt: retryAt,
        payload: {},
      });
    }
    log(
      `email_flush: sent=${counts.sent} expired=${counts.expired} failed=${counts.failed} left=${counts.left}`,
    );
  };
}
