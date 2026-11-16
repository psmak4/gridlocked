/**
 * Home's read model (M6 Task 10, wave 3's "Home in race week"): at most 5
 * blocks, the weekend, its countdown, your season and 3 leagues. The board's
 * "hot threads" join with the forum in M7, and the league rows with Task 12.
 */
import { and, count, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { events, sessions, teamEventTotals } from "@/db/schema";
import type { Db } from "@/db/types";
import { requireComplete, type Viewer } from "@/identity/viewer";
import { SCORED_KINDS } from "@/results/validate";
import { revealedSessions } from "@/spoilers/reveal";
import { currentGame } from "./current-game";
import { myTeams } from "./teams";
import { readerOf, weekendFor, type Weekend } from "./weekend";

/** One of your leagues on Home (Task 12). */
export type LeagueRow = {
  id: string;
  name: string;
  rank: number | null;
};

/** The latest scored event the season's figures include, while it's hidden. */
export type HiddenEvent = {
  name: string;
  /** Its scored sessions the reader hasn't seen: what Mark as watched marks. */
  sessionIds: string[];
};

export type SeasonBlock = {
  teamName: string;
  slot: number;
  /**
   * The season total, its global rank and the last event's points: null
   * before anything is scored, and while `hidden` (decision 2), since each
   * includes the hidden event.
   */
  total: number | null;
  rank: number | null;
  /** How many teams the rank is out of. */
  rankOf: number | null;
  lastEvent: number | null;
  hidden: HiddenEvent | null;
};

export type HomeState = {
  weekend: Weekend | null;
  season: SeasonBlock | null;
  leagues: LeagueRow[];
  /** The request's "now", so the countdown runs on the server's clock. */
  now: string;
  /** The viewer's IANA time zone (`profiles.timezone`). */
  timeZone: string;
  hasGame: boolean;
};

export const getHomeInput = z.object({
  /** Sessions to show this once ("Show it", the page's `?show=`). */
  show: z.array(z.uuid()).max(10).optional(),
});

/**
 * Your season: the first active team's latest event total. While a scored
 * session of that event is hidden, its total, rank and last-event points
 * are left out: the screen covers them (decision 2).
 */
async function seasonOf(
  db: Db,
  now: Date,
  input: {
    gameId: string;
    viewer: Viewer;
    show: string[];
  },
): Promise<SeasonBlock | null> {
  const teams = await myTeams(db, {
    gameId: input.gameId,
    userId: input.viewer.userId,
  });
  const team = teams.find((t) => t.status === "active");
  if (!team) return null;
  const block: SeasonBlock = {
    teamName: team.name,
    slot: team.slot,
    total: null,
    rank: null,
    rankOf: null,
    lastEvent: null,
    hidden: null,
  };

  const [latest] = await db
    .select({
      eventId: teamEventTotals.eventId,
      eventName: events.name,
      points: teamEventTotals.points,
      cumulative: teamEventTotals.cumulativePoints,
      rank: teamEventTotals.globalRank,
    })
    .from(teamEventTotals)
    .innerJoin(events, eq(events.id, teamEventTotals.eventId))
    .where(eq(teamEventTotals.teamId, team.id))
    .orderBy(desc(teamEventTotals.eventSequence))
    .limit(1);
  if (!latest) return block;

  const scored = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.eventId, latest.eventId),
        inArray(sessions.kind, [...SCORED_KINDS]),
      ),
    );
  const ids = scored.map((s) => s.id);
  const revealed = await revealedSessions(db, now, readerOf(input.viewer), ids);
  for (const id of input.show) if (ids.includes(id)) revealed.add(id);
  const hiddenIds = ids.filter((id) => !revealed.has(id));
  if (hiddenIds.length > 0) {
    return {
      ...block,
      hidden: { name: latest.eventName, sessionIds: hiddenIds },
    };
  }

  const [teamsAt] = await db
    .select({ n: count() })
    .from(teamEventTotals)
    .where(
      and(
        eq(teamEventTotals.gameId, input.gameId),
        eq(teamEventTotals.eventId, latest.eventId),
      ),
    );
  return {
    ...block,
    total: latest.cumulative,
    rank: latest.rank,
    rankOf: teamsAt?.n ?? null,
    lastEvent: latest.points,
  };
}

/** `/` for someone signed in. */
export async function homeState(
  db: Db,
  now: Date,
  viewer: Viewer | null,
  data: z.infer<typeof getHomeInput> = {},
): Promise<HomeState> {
  const v = requireComplete(viewer);
  const game = await currentGame(db);
  const base = {
    now: now.toISOString(),
    timeZone: v.profile.timezone,
    leagues: [],
  };
  if (!game) return { ...base, weekend: null, season: null, hasGame: false };
  const weekend = await weekendFor(db, now, {
    gameId: game.id,
    reader: readerOf(v),
  });
  const season = await seasonOf(db, now, {
    gameId: game.id,
    viewer: v,
    show: data.show ?? [],
  });
  return { ...base, weekend, season, hasGame: true };
}
