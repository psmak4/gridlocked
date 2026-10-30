/** Spike: one round's race classification, for the cacheable results page. */
import { sql } from "drizzle-orm";
import type { Db } from "@/db/types";

export type ResultRow = {
  position: number | null;
  classification: string;
  carNumber: number;
  driverId: string;
  name: string;
  code: string | null;
};

export async function raceResults(db: Db, round: number): Promise<ResultRow[]> {
  const res = await db.execute(sql`
    select r.position, r.classification, r.car_number, d.id as driver_id,
           d.given_name || ' ' || d.family_name as name, d.code
    from results r
    join sessions s on s.id = r.session_id
    join events e on e.id = s.event_id
    join seasons y on y.id = e.season_id
    join drivers d on d.id = r.driver_id
    where y.year = 2026 and e.round = ${round} and s.kind = 'race'
    order by r.position nulls last, r.car_number`);
  return ((res as { rows: unknown[] }).rows as Record<string, unknown>[]).map(
    (r) => ({
      position: r.position === null ? null : Number(r.position),
      classification: String(r.classification),
      carNumber: Number(r.car_number),
      driverId: String(r.driver_id),
      name: String(r.name),
      code: r.code === null ? null : String(r.code),
    }),
  );
}
