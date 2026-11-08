import { z } from "zod";
import { SESSION_KINDS } from "@/db/schema";

// Typed schemas and defaults for the runtime settings (DM 2.11). `getSetting`
// validates a stored row against the key's schema and falls back to the
// default when there is no row, so nothing needs a seeded `settings` row.

const positiveInt = z.number().int().positive();

const rateLimits = z.object({
  perSecond: positiveInt,
  perMinute: positiveInt.optional(),
  perHour: positiveInt.optional(),
});

/** Minutes per session kind, for defaulting `sessions.scheduled_end`. */
const sessionDurations = z.object(
  Object.fromEntries(
    SESSION_KINDS.map((kind) => [kind, positiveInt]),
  ) as Record<(typeof SESSION_KINDS)[number], typeof positiveInt>,
);

const trustLevelThreshold = z.object({
  daysVisited: z.number().int().nonnegative(),
  posts: z.number().int().nonnegative(),
  reputation: z.number().int().nonnegative(),
  accountAgeDays: z.number().int().nonnegative(),
});

export const settingSchemas = {
  /** Set below each provider's published limits (HLD §4.1). */
  provider_limits: z.object({ jolpica: rateLimits, openf1: rateLimits }),
  session_durations: sessionDurations,
  /** Start at scheduled end, back off through these gaps, give up after. */
  poll_schedule: z.object({
    backoffMinutes: z.array(positiveInt).min(1),
    giveUpAfterHours: positiveInt,
  }),
  /** Re-checks after the race (HLD §4.4). */
  finalizer_checks: z.object({ afterHours: z.array(positiveInt).min(1) }),
  validator_thresholds: z.object({ carsPerConstructor: positiveInt }),
  /**
   * Resend's free plan (HLD §10). `reservedForUrgent` of the day's emails are
   * kept for magic links, resets and delete confirmations; `alertAt` is the
   * share of `perDay` at which admins get a review item.
   */
  email_caps: z.object({
    perDay: positiveInt,
    perMonth: positiveInt,
    reservedForUrgent: z.number().int().nonnegative(),
    alertAt: z.number().gt(0).max(1),
  }),
  /** Days between username changes (DM 6.3). */
  username_change_days: positiveInt,
  /**
   * What each trust level asks for (DM 6.5): all of a level's numbers must be
   * met. `accountAgeDays` is a floor on the account's age.
   */
  trust_thresholds: z.object({
    tl1: trustLevelThreshold,
    tl2: trustLevelThreshold,
    tl3: trustLevelThreshold,
  }),
} as const;

export type SettingKey = keyof typeof settingSchemas;
export type SettingValue<K extends SettingKey> = z.infer<
  (typeof settingSchemas)[K]
>;

export const settingDefaults: { [K in SettingKey]: SettingValue<K> } = {
  provider_limits: {
    jolpica: { perSecond: 3, perHour: 400 },
    openf1: { perSecond: 2, perMinute: 25 },
  },
  session_durations: {
    fp1: 60,
    fp2: 60,
    fp3: 60,
    sprint_qualifying: 45,
    qualifying: 60,
    sprint: 45,
    race: 120,
  },
  poll_schedule: { backoffMinutes: [5, 15, 60], giveUpAfterHours: 24 },
  finalizer_checks: { afterHours: [2, 6, 24, 48] },
  validator_thresholds: { carsPerConstructor: 2 },
  email_caps: {
    perDay: 100,
    perMonth: 3000,
    reservedForUrgent: 20,
    alertAt: 0.8,
  },
  username_change_days: 30,
  trust_thresholds: {
    tl1: { daysVisited: 3, posts: 10, reputation: 0, accountAgeDays: 3 },
    tl2: { daysVisited: 15, posts: 50, reputation: 25, accountAgeDays: 15 },
    tl3: { daysVisited: 60, posts: 200, reputation: 200, accountAgeDays: 60 },
  },
};
