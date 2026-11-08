/**
 * The daily identity job (`identity_daily`, queued once a UTC day by
 * `sync_calendar`). It runs a named list of steps in order, each in its own
 * try and its own transaction, so one that fails undoes nothing another did.
 * After all have been tried it throws if any failed, and the runner retries
 * the whole job; every step is safe to run again.
 *
 * Logs carry step names, counts and error names only: never a message, which
 * could hold an address or a link.
 */
import { and, inArray, lt, sql } from "drizzle-orm";
import {
  authRateLimits,
  authSessions,
  authVerifications,
  emailOutbox,
  profiles,
  usernameHistory,
} from "@/db/schema";
import type { Db } from "@/db/types";
import type { JobHandler } from "@/jobs/runner";
import { purgeIncompleteAccountsCounted } from "./consent";
import {
  expireExports,
  unconfiguredExportStore,
  type ExportStore,
} from "./export";
import { recomputeTrustLevels } from "./trust";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A finished outbox row is kept this long: the month's cap counts them. */
const OUTBOX_KEEP_DAYS = 35;
/** A tombstone's old usernames are released after this long (DM 6.3). */
const TOMBSTONE_NAME_DAYS = 90;
/** Better Auth's longest rate-limit window is well under this. */
const RATE_LIMIT_KEEP_MS = DAY_MS;

/**
 * Deletes what has expired: sessions, verifications and rate-limit rows;
 * finished (`sent`, `failed`, `expired`) outbox rows older than 35 days, by
 * `sent_at` or, where there is none, `created_at`; and the `username_history`
 * of deleted profiles past 90 days. A live user's history stays.
 */
export async function pruneIdentity(database: Db, now: Date): Promise<void> {
  await database.transaction(async (tx) => {
    const db = tx as unknown as Db;
    await db.delete(authSessions).where(lt(authSessions.expiresAt, now));
    await db
      .delete(authVerifications)
      .where(lt(authVerifications.expiresAt, now));
    await db
      .delete(authRateLimits)
      .where(
        lt(authRateLimits.lastRequest, now.getTime() - RATE_LIMIT_KEEP_MS),
      );
    await db
      .delete(emailOutbox)
      .where(
        and(
          inArray(emailOutbox.status, ["sent", "failed", "expired"]),
          lt(
            sql`coalesce(${emailOutbox.sentAt}, ${emailOutbox.createdAt})`,
            new Date(now.getTime() - OUTBOX_KEEP_DAYS * DAY_MS),
          ),
        ),
      );
    await db.delete(usernameHistory).where(
      and(
        lt(
          usernameHistory.changedAt,
          new Date(now.getTime() - TOMBSTONE_NAME_DAYS * DAY_MS),
        ),
        inArray(
          usernameHistory.userId,
          db
            .select({ id: profiles.userId })
            .from(profiles)
            .where(sql`${profiles.status} = 'deleted'`),
        ),
      ),
    );
  });
}

type Step = (db: Db, now: Date) => Promise<string>;

/**
 * The steps, in order. `expireExports` deletes export files past their 7 days
 * and those of deleted accounts (DM 6.7).
 */
export const DAILY_STEPS = [
  "recomputeTrustLevels",
  "purgeIncompleteAccounts",
  "pruneIdentity",
  "expireExports",
] as const;
export type DailyStep = (typeof DAILY_STEPS)[number];

const defaultSteps = (store: ExportStore): Record<DailyStep, Step> => ({
  recomputeTrustLevels: async (db, now) => {
    const { changed } = await recomputeTrustLevels(db, now);
    return `changed=${changed}`;
  },
  purgeIncompleteAccounts: async (db, now) => {
    const { purged, skipped } = await purgeIncompleteAccountsCounted(db, now);
    return `purged=${purged} skipped=${skipped}`;
  },
  pruneIdentity: async (db, now) => {
    await pruneIdentity(db, now);
    return "done";
  },
  expireExports: async (db, now) => {
    const expired = await expireExports(db, now, store);
    return `expired=${expired}`;
  },
});

/**
 * `steps` replaces named steps, for tests. `exportStore` is the `exports`
 * bucket; without one, `expireExports` only fails if there is a file to
 * delete.
 */
export function createIdentityDailyHandler({
  log = console.log,
  steps = {},
  exportStore = unconfiguredExportStore,
}: {
  log?: (line: string) => void;
  steps?: Partial<Record<DailyStep, Step>>;
  exportStore?: ExportStore;
} = {}): JobHandler {
  const defaults = defaultSteps(exportStore);
  return async (_job, ctx) => {
    const db = ctx.db as unknown as Db;
    const now = ctx.clock.now();
    const failed: string[] = [];
    for (const name of DAILY_STEPS) {
      const step = steps[name] ?? defaults[name];
      try {
        // Each step opens its own transactions; a throw leaves the others'.
        const result = await step(db, now);
        log(`identity_daily: ${name} ${result}`);
      } catch (error) {
        failed.push(name);
        const kind = error instanceof Error ? error.name : "unknown";
        log(`identity_daily: ${name} failed (${kind})`);
      }
    }
    if (failed.length > 0) {
      throw new Error(`identity_daily: ${failed.join(", ")} failed`);
    }
  };
}
