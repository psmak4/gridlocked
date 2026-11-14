import { and, desc, eq, inArray } from "drizzle-orm";
import { games, seasons } from "@/db/schema";
import type { Db } from "@/db/types";

/** The game the fantasy screens are about. */
export type CurrentGame = {
  id: string;
  slug: string;
  name: string;
  status: "open" | "running";
  seasonYear: number;
};

/**
 * The season fantasy game that is open or running, from the latest season
 * that has one, or null before a game opens (and after the last completes).
 */
export async function currentGame(db: Db): Promise<CurrentGame | null> {
  const [row] = await db
    .select({
      id: games.id,
      slug: games.slug,
      name: games.name,
      status: games.status,
      seasonYear: seasons.year,
    })
    .from(games)
    .innerJoin(seasons, eq(seasons.id, games.seasonId))
    .where(
      and(
        eq(games.gameType, "season_fantasy"),
        inArray(games.status, ["open", "running"]),
      ),
    )
    .orderBy(desc(seasons.year))
    .limit(1);
  if (!row) return null;
  return { ...row, status: row.status as CurrentGame["status"] };
}
