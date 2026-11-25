/**
 * Free-tier usage (M8 Task 14, HLD §11.4): the daily snapshot the
 * `usage-snapshot.yml` workflow records, a `usage_high` warning for each
 * meter at 70% or more (once per meter per month), and the meters the
 * settings screen shows, with today's account emails counted here from the
 * outbox. While a warning is open and its meter still reads high, every
 * admin gets a `usage_high` notification once a day, pushed to those with
 * push on (M9 Task 10).
 */
import { and, desc, eq, gte, lt, or, sql } from "drizzle-orm";
import {
  emailOutbox,
  notifications,
  profiles,
  reviewItems,
  usageSnapshots,
  users,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { newId } from "@/lib/ids";
import { checkedNow, type ClockDb } from "@/lib/resolve-clock";
import { notify } from "@/notifications/write";
import { openReviewItem } from "@/reference/review";
import { getSetting } from "@/settings";

/** The free limits (HLD §11.3, §11.4): per month. */
export const USAGE_LIMITS = {
  neonComputeHours: 100,
  neonTransferGb: 5,
  vercelCpuHours: 4,
} as const;
export type UsageLimits = { [K in keyof typeof USAGE_LIMITS]: number };

/** A meter warns from here. */
export const WARN_AT = 0.7;

export type UsageSnapshot = {
  neonComputeHours: number;
  neonTransferGb: number;
  /** Null when Vercel reported no function CPU. */
  vercelCpuHours: number | null;
};

const METERS = [
  { id: "neon_compute", field: "neonComputeHours", label: "Neon compute" },
  { id: "neon_transfer", field: "neonTransferGb", label: "Neon transfer" },
  {
    id: "vercel_cpu",
    field: "vercelCpuHours",
    label: "Vercel function CPU",
  },
] as const;

const monthOf = (at: Date) => at.toISOString().slice(0, 7);
const dayOf = (at: Date) => at.toISOString().slice(0, 10);

/**
 * Tells every active admin a meter is high, once per meter per day: the
 * group key carries the day, and a row with it (read or not) means done.
 * `notify` writes the bell's row and queues its push for those with a device
 * and push on.
 */
async function alertAdmins(
  db: Db,
  now: Date,
  meter: { id: string; label: string },
  pct: number,
): Promise<void> {
  const groupKey = `usage_high:${meter.id}:${dayOf(now)}`;
  const admins = await db
    .select({ id: users.id })
    .from(users)
    .innerJoin(profiles, eq(profiles.userId, users.id))
    .where(and(eq(users.role, "admin"), eq(profiles.status, "active")));
  for (const admin of admins) {
    const [done] = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(
          eq(notifications.userId, admin.id),
          eq(notifications.groupKey, groupKey),
        ),
      );
    if (done) continue;
    await notify(db, now, {
      userId: admin.id,
      kind: "usage_high",
      groupKey,
      data: { meter: meter.label, pct },
    });
  }
}

/**
 * Records one snapshot, and opens a `usage_high` warning for each meter at
 * 70% or more of its limit, once per meter per month (even if resolved).
 */
export async function recordUsage(
  db: Db,
  now: Date,
  snapshot: UsageSnapshot,
): Promise<{ warned: string[] }> {
  const limits: UsageLimits = { ...USAGE_LIMITS };
  return db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    await t.insert(usageSnapshots).values({
      id: newId(),
      takenAt: now,
      ...snapshot,
      limits,
    });
    const warned: string[] = [];
    for (const meter of METERS) {
      const value = snapshot[meter.field];
      const limit = limits[meter.field];
      if (value === null || value < limit * WARN_AT) continue;
      const dedupeKey = `usage_high:${meter.id}:${monthOf(now)}`;
      const pct = Math.round((value / limit) * 100);
      const [seen] = await t
        .select({ status: reviewItems.status })
        .from(reviewItems)
        .where(eq(reviewItems.dedupeKey, dedupeKey));
      if (seen) {
        // Still open: today's reminder. Resolved or dismissed: an admin has it.
        if (seen.status === "open") await alertAdmins(t, now, meter, pct);
        continue;
      }
      await openReviewItem(t, now, {
        kind: "usage_high",
        seasonId: null,
        details: {
          meter: meter.id,
          label: meter.label,
          value,
          limit,
          month: monthOf(now),
        },
        dedupeKey,
      });
      await alertAdmins(t, now, meter, pct);
      warned.push(meter.id);
    }
    return { warned };
  });
}

/**
 * The daily reading: checks the database's clock first, reads the providers
 * for the real month, then records the row at the database's "now" (the
 * replay's, on the beta: M9 Task 13). Nothing is written unless `read`
 * succeeds.
 */
export async function recordReading(
  db: Db & ClockDb,
  env: Record<string, string | undefined>,
  realNow: Date,
  read: (realNow: Date) => Promise<UsageSnapshot>,
): Promise<{ warned: string[] }> {
  const now = await checkedNow(db, env, realNow);
  return recordUsage(db, now, await read(realNow));
}

export type UsageMeter = {
  label: string;
  /** "74 of 100 CU-hours"; null with no reading. */
  value: string | null;
  /** Of the limit, rounded; null with no reading. */
  pct: number | null;
  note: string;
  warn: boolean;
};

const UNITS: Record<(typeof METERS)[number]["field"], string> = {
  neonComputeHours: "CU-hours",
  neonTransferGb: "GB",
  vercelCpuHours: "hours",
};

/** 74, 1.5, 0.25: at most two decimals, no trailing zeros. */
const num = (n: number) => String(Math.round(n * 100) / 100);

function meter(
  label: string,
  value: number | null,
  limit: number,
  unit: string,
  missing: string,
): UsageMeter {
  if (value === null) {
    return { label, value: null, pct: null, note: missing, warn: false };
  }
  const pct = Math.round((value / limit) * 100);
  const warn = value >= limit * WARN_AT;
  return {
    label,
    value: `${num(value)} of ${num(limit)}${unit ? ` ${unit}` : ""}`,
    pct,
    warn,
    note: warn ? "Over 70%: plan to upgrade before it runs out" : "Fine",
  };
}

/**
 * The settings screen's meters: the latest snapshot's three, and today's
 * account emails (sent today, and queued) against `email_caps.perDay`.
 */
export async function usageMeters(db: Db, now: Date): Promise<UsageMeter[]> {
  const [latest] = await db
    .select()
    .from(usageSnapshots)
    .orderBy(desc(usageSnapshots.takenAt))
    .limit(1);
  // A reading from an earlier month is no reading of this one.
  const current = latest && monthOf(latest.takenAt) === monthOf(now);
  const limits = (current ? latest.limits : USAGE_LIMITS) as UsageLimits;
  const meters = METERS.map((m) =>
    meter(
      m.label,
      current ? latest[m.field] : null,
      limits[m.field],
      UNITS[m.field],
      !current
        ? "No reading yet"
        : m.field === "vercelCpuHours"
          ? "No reading from Vercel"
          : "No reading yet",
    ),
  );

  const dayStart = new Date(now.toISOString().slice(0, 10) + "T00:00:00Z");
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);
  const [emails] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(emailOutbox)
    .where(
      or(
        eq(emailOutbox.status, "queued"),
        and(
          eq(emailOutbox.status, "sent"),
          gte(emailOutbox.sentAt, dayStart),
          lt(emailOutbox.sentAt, dayEnd),
        ),
      ),
    );
  const caps = await getSetting(db, "email_caps");
  meters.push(
    meter("Account emails today", emails?.n ?? 0, caps.perDay, "", ""),
  );
  return meters;
}
