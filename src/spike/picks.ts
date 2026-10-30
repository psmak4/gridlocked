/**
 * Spike: one pick per user per round (plan Task 3), in the spike-only
 * `spike_picks` table.
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "@/db/types";

/** The 2026 calendar has 23 rounds. */
export const pickInput = z.object({
  round: z.number().int().min(1).max(23),
  driverId: z.uuid(),
});
export type PickInput = z.infer<typeof pickInput>;

export type Pick = { round: number; driverId: string };

export async function savePick(
  db: Db,
  userId: string,
  pick: PickInput,
): Promise<void> {
  await db.execute(sql`
    insert into spike_picks (user_id, round, driver_id)
    values (${userId}, ${pick.round}, ${pick.driverId})
    on conflict (user_id, round) do update set driver_id = excluded.driver_id`);
}

export async function listPicks(db: Db, userId: string): Promise<Pick[]> {
  const res = await db.execute(sql`
    select round, driver_id from spike_picks
    where user_id = ${userId} order by round`);
  return (
    (res as { rows: unknown[] }).rows as { round: number; driver_id: string }[]
  ).map((r) => ({
    round: Number(r.round),
    driverId: r.driver_id,
  }));
}
