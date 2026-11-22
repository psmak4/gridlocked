import {
  doublePrecision,
  index,
  jsonb,
  pgTable,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * One reading of the free tiers' monthly usage (M8 Task 14, HLD §11.4),
 * written once a day by `usage-snapshot.yml`: Neon's compute and transfer
 * for the billing period so far, and Vercel's function CPU for the month
 * (null when Vercel reported none). `limits` keeps the free limits the
 * reading was measured against.
 */
export const usageSnapshots = pgTable(
  "usage_snapshots",
  {
    id: uuid("id").primaryKey(),
    takenAt: timestamp("taken_at", { withTimezone: true }).notNull(),
    neonComputeHours: doublePrecision("neon_compute_hours").notNull(),
    neonTransferGb: doublePrecision("neon_transfer_gb").notNull(),
    vercelCpuHours: doublePrecision("vercel_cpu_hours"),
    limits: jsonb("limits").notNull(),
  },
  (t) => [index("usage_snapshots_taken_at_idx").on(t.takenAt)],
);
