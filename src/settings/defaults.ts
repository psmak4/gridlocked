import { z } from "zod";
import { SESSION_KINDS } from "@/db/schema";

// Typed schemas and defaults for the runtime settings (DM 2.11). `getSetting`
// validates a stored row against the key's schema and falls back to the
// default when there is no row, so nothing needs a seeded `settings` row.

const positiveInt = z.number().int().positive();
const nonNegativeInt = z.number().int().nonnegative();

const postTier = z.object({
  replies: nonNegativeInt,
  threads: nonNegativeInt,
  links: nonNegativeInt.nullable(),
});

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
  /**
   * The two switches staff may flip (M8 Task 13): live chat (session threads
   * stay in discussion mode and the refresh answers 404) and Web Push (the
   * fan-out sends nothing; in-app notifications are still written).
   */
  feature_flags: z.strictObject({ chat: z.boolean(), push: z.boolean() }),
  /** Set below each provider's published limits (HLD §4.1). */
  provider_limits: z.object({ jolpica: rateLimits, openf1: rateLimits }),
  session_durations: sessionDurations,
  /**
   * Start at scheduled end, back off through these gaps, give up after. At
   * most 10 gaps, none over a day (M9 Task 7).
   */
  poll_schedule: z.object({
    backoffMinutes: z
      .array(positiveInt.max(24 * 60))
      .min(1)
      .max(10),
    giveUpAfterHours: positiveInt,
  }),
  /** Re-checks after the race (HLD §4.4), none over a week on. */
  finalizer_checks: z.object({
    afterHours: z.array(positiveInt.max(168)).min(1),
  }),
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
  /**
   * Tries at a league join code per user (M6 Task 12, Review Focus 5): a
   * right code counts too, so codes can't be guessed.
   */
  league_join_limit: z.object({
    windowSeconds: positiveInt,
    max: positiveInt,
  }),
  /**
   * The forum's limits per trust level (HLD §7.4, M7's calls). Counts are per
   * `windowSeconds`; `links` is per post, null for unlimited. Moderators and
   * admins use `tl3`.
   */
  post_limits: z.object({
    windowSeconds: positiveInt,
    tl0: postTier,
    tl1: postTier,
    tl2: postTier,
    tl3: postTier,
    mentionsPerPost: positiveInt,
    duplicateWindowHours: positiveInt,
  }),
  /**
   * Live chat (HLD §7.2, §11.2): slow mode in seconds per trust level (a
   * moderator can raise it per thread), the message length, a refresh's
   * size and its window.
   */
  chat_limits: z.object({
    slowModeSeconds: z.object({
      tl0: nonNegativeInt,
      tl1: nonNegativeInt,
      tl2: nonNegativeInt,
      tl3: nonNegativeInt,
    }),
    maxLength: positiveInt,
    refreshLimit: positiveInt,
    windowSeconds: positiveInt,
  }),
  /**
   * Report weight by the reporter's trust level (HLD §7.4, M7's call): when
   * an item's weights reach `threshold`, the content hides pending review.
   * Moderators and admins use `tl3`; a logged-out report weighs `visitor`.
   * That is 0: one person can file any number of logged-out reports, so
   * they reach a moderator without counting toward auto-hide.
   */
  report_weights: z.object({
    tl0: z.number().nonnegative(),
    tl1: z.number().nonnegative(),
    tl2: z.number().nonnegative(),
    tl3: z.number().nonnegative(),
    visitor: z.number().nonnegative(),
    threshold: z.number().positive(),
  }),
} as const;

export type SettingKey = keyof typeof settingSchemas;
export type SettingValue<K extends SettingKey> = z.infer<
  (typeof settingSchemas)[K]
>;

export const settingDefaults: { [K in SettingKey]: SettingValue<K> } = {
  feature_flags: { chat: true, push: true },
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
  league_join_limit: { windowSeconds: 600, max: 10 },
  post_limits: {
    windowSeconds: 600,
    tl0: { replies: 3, threads: 0, links: 0 },
    tl1: { replies: 10, threads: 2, links: 1 },
    tl2: { replies: 30, threads: 5, links: null },
    tl3: { replies: 30, threads: 5, links: null },
    mentionsPerPost: 5,
    duplicateWindowHours: 24,
  },
  chat_limits: {
    slowModeSeconds: { tl0: 10, tl1: 5, tl2: 0, tl3: 0 },
    maxLength: 500,
    refreshLimit: 50,
    windowSeconds: 3,
  },
  report_weights: {
    tl0: 1,
    tl1: 1,
    tl2: 2,
    tl3: 5,
    visitor: 0,
    threshold: 5,
  },
};
