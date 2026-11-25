/**
 * The daily free-tier reading (M8 Task 14, HLD §11.4), run by
 * `usage-snapshot.yml` at 05:00 UTC:
 *
 *   NEON_API_KEY=… NEON_PROJECT_ID=… VERCEL_USAGE_TOKEN=… \
 *   DATABASE_URL=postgres://… pnpm usage-snapshot
 *
 * With CLOCK_MODE=replay the database is the beta's: the reading is still of
 * the real month, and the row is dated at the replay's now.
 *
 * It reads Neon's project (compute and transfer for the billing period so
 * far, the Free plan's only usage source) and Vercel's FOCUS billing charges
 * for the month (function CPU), then records one `usage_snapshots` row and
 * any 70% warnings. Any error, a missing key included, writes nothing and
 * fails the run, so a broken reading shows as a red run, never a zero
 * meter. Keys go only into their own provider's Authorization header and
 * are never printed.
 */
import { pathToFileURL } from "node:url";
import { z } from "zod";
import type { UsageSnapshot } from "@/staff/usage";

export type SnapshotEnv = {
  NEON_API_KEY?: string;
  NEON_PROJECT_ID?: string;
  VERCEL_USAGE_TOKEN?: string;
  /** Only for a team account; a personal Hobby account leaves it out. */
  VERCEL_TEAM_ID?: string;
};

type Deps = {
  fetch: typeof globalThis.fetch;
  log: (line: string) => void;
};

const neonProject = z.object({
  project: z.object({
    compute_time_seconds: z.number().nonnegative(),
    data_transfer_bytes: z.number().nonnegative(),
  }),
});

/** Neon's `GET /projects/{id}`: CU-seconds → CU-hours, bytes → GB (10^9). */
export function neonUsage(
  answer: unknown,
): Pick<UsageSnapshot, "neonComputeHours" | "neonTransferGb"> {
  const parsed = neonProject.safeParse(answer);
  if (!parsed.success) throw new Error("Neon usage: unexpected answer");
  const { compute_time_seconds, data_transfer_bytes } = parsed.data.project;
  return {
    neonComputeHours: compute_time_seconds / 3600,
    neonTransferGb: data_transfer_bytes / 1e9,
  };
}

/** Hours per unit Vercel might report CPU in. */
const PER_HOUR: [RegExp, number][] = [
  [/^(ms|milliseconds?)$/i, 3_600_000],
  [/^(s|secs?|seconds?)$/i, 3600],
  [/^(min|minutes?)$/i, 60],
  [/^(h|hrs?|hours?)$/i, 1],
];

const charge = z.object({
  ConsumedQuantity: z.string().optional(),
  ConsumedUnit: z.string().optional(),
  ServiceName: z.string().optional(),
  SkuId: z.string().optional(),
});

/**
 * Function CPU hours from Vercel's FOCUS charges (JSONL): the rows naming
 * active CPU, in whatever time unit they use. Null when there are none, so
 * the meter says so rather than showing zero.
 */
export function vercelCpuHours(jsonl: string): number | null {
  let total = 0;
  let found = false;
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let row: z.infer<typeof charge>;
    try {
      row = charge.parse(JSON.parse(line));
    } catch {
      throw new Error("Vercel usage: unexpected answer");
    }
    const name = `${row.ServiceName ?? ""} ${row.SkuId ?? ""}`;
    if (!/active[\s_-]*cpu/i.test(name)) continue;
    const divisor = PER_HOUR.find(([unit]) =>
      unit.test((row.ConsumedUnit ?? "").trim()),
    )?.[1];
    const quantity = Number(row.ConsumedQuantity);
    if (divisor === undefined || !Number.isFinite(quantity)) {
      throw new Error("Vercel usage: unexpected CPU unit");
    }
    total += quantity / divisor;
    found = true;
  }
  return found ? Math.round(total * 10_000) / 10_000 : null;
}

function required(env: SnapshotEnv, name: keyof SnapshotEnv): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

/** Reads both providers; throws, with no key in the message, on any error. */
export async function takeSnapshot(
  env: SnapshotEnv,
  now: Date,
  deps: Deps,
): Promise<UsageSnapshot> {
  const neonKey = required(env, "NEON_API_KEY");
  const projectId = required(env, "NEON_PROJECT_ID");
  const vercelToken = required(env, "VERCEL_USAGE_TOKEN");

  const neon = await deps.fetch(
    `https://console.neon.tech/api/v2/projects/${encodeURIComponent(projectId)}`,
    {
      headers: {
        Authorization: `Bearer ${neonKey}`,
        Accept: "application/json",
      },
    },
  );
  if (!neon.ok) throw new Error(`Neon usage: HTTP ${neon.status}`);
  const neonPart = neonUsage(await neon.json().catch(() => null));

  const from = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  ).toISOString();
  const query = new URLSearchParams({ from, to: now.toISOString() });
  if (env.VERCEL_TEAM_ID?.trim())
    query.set("teamId", env.VERCEL_TEAM_ID.trim());
  const vercel = await deps.fetch(
    `https://api.vercel.com/v1/billing/charges?${query}`,
    { headers: { Authorization: `Bearer ${vercelToken}` } },
  );
  if (!vercel.ok) throw new Error(`Vercel usage: HTTP ${vercel.status}`);
  const snapshot = {
    ...neonPart,
    vercelCpuHours: vercelCpuHours(await vercel.text()),
  };
  deps.log(
    `usage: Neon ${snapshot.neonComputeHours.toFixed(2)} CU-hours, ${snapshot.neonTransferGb.toFixed(2)} GB; Vercel CPU ${
      snapshot.vercelCpuHours === null
        ? "no reading"
        : `${snapshot.vercelCpuHours.toFixed(2)} hours`
    }`,
  );
  return snapshot;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const { createDb } = await import("@/db/client");
  const { systemClock } = await import("@/lib/clock");
  const { recordReading } = await import("@/staff/usage");
  const handle = createDb(url);
  try {
    // Both readings first: nothing is written unless both succeed.
    const { warned } = await recordReading(
      handle.db(),
      process.env,
      systemClock.now(),
      (now) =>
        takeSnapshot(process.env, now, {
          fetch,
          log: (line) => console.log(line),
        }),
    );
    console.log(
      warned.length > 0
        ? `recorded; over 70%: ${warned.join(", ")}`
        : "recorded; every meter under 70%",
    );
  } finally {
    await handle.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    // The message only: a stack or cause could carry a request's headers.
    console.error(error instanceof Error ? error.message : "usage: failed");
    process.exit(1);
  });
}
