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
};
