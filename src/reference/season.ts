import { eq } from "drizzle-orm";
import { seasons } from "@/db/schema";
import type { Db } from "@/db/types";
import { newId } from "@/lib/ids";

/** The season row for `year`, created as `upcoming` when absent. */
export async function ensureSeason(
  db: Db,
  year: number,
  now: Date,
): Promise<typeof seasons.$inferSelect> {
  const [found] = await db.select().from(seasons).where(eq(seasons.year, year));
  if (found) return found;
  const [created] = await db
    .insert(seasons)
    .values({
      id: newId(),
      year,
      status: "upcoming",
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return created!;
}
