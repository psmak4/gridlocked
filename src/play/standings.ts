/**
 * League standings on the fantasy screens (M6 Task 13): one league's table,
 * 50 rows at a time. The tables are stored (`league_standings`, DM 4.7, and
 * `team_event_totals` for the global league); this reads them a page at a
 * time by rank (keyset paging, which the `(league_id, rank)` and
 * `(game_id, event_id, global_rank)` indexes serve), names each row's
 * manager, and covers the table while its latest event is hidden from the
 * reader (M6 decision 2).
 */
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  max,
} from "drizzle-orm";
import { z } from "zod";
import {
  events,
  gameEvents,
  leagueMemberships,
  leagueStandings,
  leagues,
  profiles,
  sessions,
  teamEventTotals,
  teams,
  users,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { GameError } from "@/game/errors";
import { requireComplete, type Viewer } from "@/identity/viewer";
import { SCORED_KINDS } from "@/results/validate";
import { revealedSessions, type Reader } from "@/spoilers/reveal";
import { currentGame } from "./current-game";
import { readerOf } from "./weekend";

export const STANDINGS_PAGE = 50;

/** One team in the table. */
export type StandingRow = {
  teamId: string;
  /** Shared on a full tie; the next rank skips. */
  rank: number;
  /** Places gained since the event before ("▲3" is 3); null for none. */
  move: number | null;
  /** "Deleted team" for a deleted account's team. */
  teamName: string;
  /** Null for a deleted account. */
  username: string | null;
  /** The total over the league's range. */
  points: number;
  /** The team's points at the through event. */
  last: number | null;
  /** One of the reader's teams: outlined. */
  mine: boolean;
};

export type StandingsPage = {
  league: {
    id: string;
    slug: string;
    /** "Everyone" for the global league. */
    name: string;
    kind: (typeof leagues.$inferSelect)["kind"];
    /** A mini-league's rounds, "Rounds 5–9"; null for the whole season. */
    range: string | null;
    /** Current members with an active team. */
    members: number;
    /** The code to invite with, for a member of a public or private league. */
    joinCode: string | null;
    /** The reader's teams in it: "Leave league" for a public or private one. */
    myTeams: Array<{ id: string; name: string }>;
  };
  /** The table's latest event; null before anything in its range is scored. */
  through: { round: number; name: string } | null;
  status: "provisional" | "final" | null;
  /**
   * The through event has a scored session the reader hasn't seen: `rows`,
   * `yours` and `next` are empty (decision 2).
   */
  hidden: boolean;
  /** Those sessions, for "Mark as watched". */
  hiddenSessionIds: string[];
  rows: StandingRow[];
  /** The reader's own teams in the table, wherever they are. */
  yours: StandingRow[];
  /** The rank to read on from (`afterRank`), or null on the last page. */
  next: number | null;
  /** How ties split, and a mini-league's rounds. */
  tiebreak: string;
  /**
   * Which table this page read: the through event and when its totals were
   * last written. "See more" sends it back, so a later page can tell the
   * table has changed since the first (M6 carry-over).
   */
  version: string;
  /** The `version` sent back was another table's: this is the new first page. */
  restarted: boolean;
};

const TIEBREAK = "Teams on the same points are split by who got there first.";

/** "Rounds 5–9", "Round 5", "From round 6". */
export function rangeWords(from: number, to: number | null): string {
  if (to === null) return `From round ${from}`;
  if (to === from) return `Round ${from}`;
  return `Rounds ${from}–${to}`;
}

/** The tiebreak note, with the range for a mini-league. */
export function tiebreakWords(
  rounds: { from: number; to: number | null } | null,
): string {
  if (!rounds) return TIEBREAK;
  const { from, to } = rounds;
  const counts =
    to === null
      ? `Counts from round ${from} on.`
      : to === from
        ? `Counts round ${from} only.`
        : `Counts rounds ${from} to ${to} only.`;
  return `${TIEBREAK} ${counts}`;
}

type RawRow = {
  teamId: string;
  rank: number;
  previousRank: number | null;
  points: number;
};

/**
 * One page by rank, without splitting a shared rank across two pages: it
 * reads `limit + 1` rows after `afterRank`, and when the last row kept shares
 * its rank with the one after, the page grows to the end of that rank.
 */
async function pageOf(
  read: (
    afterRank: number,
    upTo: number | null,
    limit: number | null,
  ) => Promise<RawRow[]>,
  afterRank: number,
  limit: number,
): Promise<{ rows: RawRow[]; next: number | null }> {
  const first = await read(afterRank, null, limit + 1);
  if (first.length <= limit) return { rows: first, next: null };
  const cut = first[limit - 1]!.rank;
  // The row after the page is past the cut: there's more.
  if (first[limit]!.rank !== cut) {
    return { rows: first.slice(0, limit), next: cut };
  }
  // The page grows to the end of the shared rank; there's more only if a
  // row comes after it (a tie can run to the end of the table).
  const rows = await read(afterRank, cut, null);
  const more = await read(cut, null, 1);
  return { rows, next: more.length > 0 ? cut : null };
}

/** The scored sessions of an event the reader hasn't seen. */
async function hiddenSessionsOf(
  db: Db,
  now: Date,
  reader: Reader,
  eventId: string,
  show: string[],
): Promise<string[]> {
  const scored = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.eventId, eventId),
        inArray(sessions.kind, [...SCORED_KINDS]),
      ),
    );
  const ids = scored.map((s) => s.id);
  const revealed = await revealedSessions(db, now, reader, ids);
  for (const id of show) revealed.add(id);
  return ids.filter((id) => !revealed.has(id));
}

/**
 * A league's standings page. `afterRank` reads on from a rank (See more);
 * `show` reveals those sessions on this page only ("Show it"). A private
 * league is only for its members and its owner: anyone else gets
 * `league_not_found`, as for a slug that isn't one.
 */
export async function standingsPage(
  db: Db,
  now: Date,
  input: {
    gameId: string;
    slug: string;
    reader: Reader;
    afterRank?: number;
    /** The first page's `version`, sent back with `afterRank`. */
    version?: string | null;
    limit?: number;
    show?: string[];
  },
): Promise<StandingsPage> {
  let afterRank = input.afterRank ?? 0;
  const limit = input.limit ?? STANDINGS_PAGE;
  const userId = input.reader?.userId ?? null;
  const [league] = await db
    .select()
    .from(leagues)
    .where(
      and(
        eq(leagues.gameId, input.gameId),
        eq(leagues.slug, input.slug),
        eq(leagues.status, "active"),
      ),
    );
  if (!league) throw new GameError("league_not_found", "No such league");

  // The reader's teams in this league (every active team, for the global one).
  const myTeams: Array<{ id: string; name: string }> =
    userId === null
      ? []
      : league.kind === "global"
        ? await db
            .select({ id: teams.id, name: teams.name })
            .from(teams)
            .where(
              and(
                eq(teams.gameId, input.gameId),
                eq(teams.userId, userId),
                eq(teams.status, "active"),
              ),
            )
        : await db
            .select({ id: leagueMemberships.teamId, name: teams.name })
            .from(leagueMemberships)
            .innerJoin(teams, eq(teams.id, leagueMemberships.teamId))
            .where(
              and(
                eq(leagueMemberships.leagueId, league.id),
                isNull(leagueMemberships.leftAt),
                eq(teams.userId, userId),
                eq(teams.status, "active"),
              ),
            );
  const myTeamIds = new Set(myTeams.map((t) => t.id));
  if (
    league.kind === "private" &&
    myTeamIds.size === 0 &&
    league.ownerUserId !== userId
  ) {
    // Not "not yours": a private league's existence isn't told to outsiders.
    throw new GameError("league_not_found", "Private league");
  }

  const rounds = await db
    .select({
      sequence: gameEvents.sequence,
      round: events.round,
      name: events.name,
    })
    .from(gameEvents)
    .innerJoin(events, eq(events.id, gameEvents.eventId))
    .where(eq(gameEvents.gameId, input.gameId));
  const roundAt = (sequence: number | null) =>
    sequence === null
      ? null
      : (rounds.find((r) => r.sequence === sequence) ?? null);
  const mini =
    league.kind !== "global" &&
    (league.startSequence !== 1 || league.endSequence !== null);
  const range = mini
    ? {
        from: roundAt(league.startSequence)?.round ?? league.startSequence,
        to:
          league.endSequence === null
            ? null
            : (roundAt(league.endSequence)?.round ?? league.endSequence),
      }
    : null;

  const [{ n: members } = { n: 0 }] =
    league.kind === "global"
      ? await db
          .select({ n: count() })
          .from(teams)
          .where(
            and(eq(teams.gameId, input.gameId), eq(teams.status, "active")),
          )
      : await db
          .select({ n: count() })
          .from(leagueMemberships)
          .innerJoin(teams, eq(teams.id, leagueMemberships.teamId))
          .where(
            and(
              eq(leagueMemberships.leagueId, league.id),
              isNull(leagueMemberships.leftAt),
              eq(teams.status, "active"),
            ),
          );

  // The through event, and how to read the table by rank.
  let through: {
    eventId: string;
    sequence: number;
    status: "provisional" | "final";
  } | null = null;
  let read: (
    afterRank: number,
    upTo: number | null,
    limit: number | null,
  ) => Promise<RawRow[]>;
  let readTeams: (teamIds: string[]) => Promise<RawRow[]>;

  if (league.kind === "global") {
    const [latest] = await db
      .select({
        eventId: teamEventTotals.eventId,
        sequence: teamEventTotals.eventSequence,
        status: teamEventTotals.status,
      })
      .from(teamEventTotals)
      .where(eq(teamEventTotals.gameId, input.gameId))
      .orderBy(desc(teamEventTotals.eventSequence))
      .limit(1);
    through = latest ?? null;
    const [before] = latest
      ? await db
          .select({ eventId: teamEventTotals.eventId })
          .from(teamEventTotals)
          .where(
            and(
              eq(teamEventTotals.gameId, input.gameId),
              lt(teamEventTotals.eventSequence, latest.sequence),
            ),
          )
          .orderBy(desc(teamEventTotals.eventSequence))
          .limit(1)
      : [];
    const previous = async (rows: Omit<RawRow, "previousRank">[]) => {
      if (!before || rows.length === 0) {
        return rows.map((r) => ({ ...r, previousRank: null }));
      }
      const ranks = new Map(
        (
          await db
            .select({
              teamId: teamEventTotals.teamId,
              rank: teamEventTotals.globalRank,
            })
            .from(teamEventTotals)
            .where(
              and(
                eq(teamEventTotals.eventId, before.eventId),
                inArray(
                  teamEventTotals.teamId,
                  rows.map((r) => r.teamId),
                ),
              ),
            )
        ).map((r) => [r.teamId, r.rank]),
      );
      return rows.map((r) => ({
        ...r,
        previousRank: ranks.get(r.teamId) ?? null,
      }));
    };
    const select = {
      teamId: teamEventTotals.teamId,
      rank: teamEventTotals.globalRank,
      points: teamEventTotals.cumulativePoints,
    };
    const at = (eventId: string) =>
      and(
        eq(teamEventTotals.gameId, input.gameId),
        eq(teamEventTotals.eventId, eventId),
      );
    read = async (after, upTo, take) => {
      if (!latest) return [];
      const q = db
        .select(select)
        .from(teamEventTotals)
        .where(
          and(
            at(latest.eventId),
            gt(teamEventTotals.globalRank, after),
            upTo === null ? undefined : lte(teamEventTotals.globalRank, upTo),
          ),
        )
        .orderBy(asc(teamEventTotals.globalRank), asc(teamEventTotals.teamId));
      return previous(take === null ? await q : await q.limit(take));
    };
    readTeams = async (teamIds) =>
      !latest || teamIds.length === 0
        ? []
        : previous(
            await db
              .select(select)
              .from(teamEventTotals)
              .where(
                and(
                  at(latest.eventId),
                  inArray(teamEventTotals.teamId, teamIds),
                ),
              )
              .orderBy(asc(teamEventTotals.globalRank)),
          );
  } else {
    const [first] = await db
      .select({
        eventId: leagueStandings.throughEventId,
        status: leagueStandings.status,
      })
      .from(leagueStandings)
      .where(eq(leagueStandings.leagueId, league.id))
      .limit(1);
    if (first) {
      const [seq] = await db
        .select({ sequence: gameEvents.sequence })
        .from(gameEvents)
        .where(
          and(
            eq(gameEvents.gameId, input.gameId),
            eq(gameEvents.eventId, first.eventId),
          ),
        );
      through = {
        eventId: first.eventId,
        sequence: seq?.sequence ?? 0,
        status: first.status,
      };
    }
    const select = {
      teamId: leagueStandings.teamId,
      rank: leagueStandings.rank,
      previousRank: leagueStandings.previousRank,
      points: leagueStandings.points,
    };
    read = async (after, upTo, take) => {
      const q = db
        .select(select)
        .from(leagueStandings)
        .where(
          and(
            eq(leagueStandings.leagueId, league.id),
            gt(leagueStandings.rank, after),
            upTo === null ? undefined : lte(leagueStandings.rank, upTo),
          ),
        )
        .orderBy(asc(leagueStandings.rank), asc(leagueStandings.teamId));
      return take === null ? q : q.limit(take);
    };
    readTeams = async (teamIds) =>
      teamIds.length === 0
        ? []
        : db
            .select(select)
            .from(leagueStandings)
            .where(
              and(
                eq(leagueStandings.leagueId, league.id),
                inArray(leagueStandings.teamId, teamIds),
              ),
            )
            .orderBy(asc(leagueStandings.rank));
  }

  const throughRound = through
    ? (rounds.find((r) => r.sequence === through.sequence) ?? null)
    : null;
  const hiddenSessionIds = through
    ? await hiddenSessionsOf(
        db,
        now,
        input.reader,
        through.eventId,
        input.show ?? [],
      )
    : [];
  const hidden = hiddenSessionIds.length > 0;

  const version = through
    ? await tableVersion(db, input.gameId, through.eventId)
    : "";
  // Reading on from a table that has changed would join two tables: start
  // again from the top of the new one.
  const restarted =
    afterRank > 0 &&
    input.version !== undefined &&
    input.version !== null &&
    input.version !== version;
  if (restarted) afterRank = 0;

  const base: StandingsPage = {
    league: {
      id: league.id,
      slug: league.slug,
      name: league.kind === "global" ? "Everyone" : league.name,
      kind: league.kind,
      range: range ? rangeWords(range.from, range.to) : null,
      members,
      joinCode:
        (league.kind === "public" || league.kind === "private") &&
        (myTeamIds.size > 0 || league.ownerUserId === userId)
          ? league.joinCode
          : null,
      myTeams,
    },
    through: throughRound
      ? { round: throughRound.round, name: throughRound.name }
      : null,
    status: through?.status ?? null,
    hidden,
    hiddenSessionIds,
    rows: [],
    yours: [],
    next: null,
    tiebreak: tiebreakWords(range),
    version,
    restarted,
  };
  if (hidden || !through) return base;

  const page = await pageOf(read, afterRank, limit);
  const mine = await readTeams([...myTeamIds]);
  const named = await nameRows(
    db,
    [...page.rows, ...mine],
    through.eventId,
    myTeamIds,
  );
  return {
    ...base,
    rows: named.slice(0, page.rows.length),
    yours: named.slice(page.rows.length),
    next: page.next,
  };
}

/**
 * A table's version: its through event, and the newest `computed_at` of the
 * game's totals there, which a re-score of that event moves on.
 */
async function tableVersion(
  db: Db,
  gameId: string,
  eventId: string,
): Promise<string> {
  const [row] = await db
    .select({ at: max(teamEventTotals.computedAt) })
    .from(teamEventTotals)
    .where(
      and(
        eq(teamEventTotals.gameId, gameId),
        eq(teamEventTotals.eventId, eventId),
      ),
    );
  return `${eventId}@${row?.at?.toISOString() ?? "none"}`;
}

/** Each row's team name, manager and points at the through event. */
async function nameRows(
  db: Db,
  rows: RawRow[],
  throughEventId: string,
  mine: Set<string>,
): Promise<StandingRow[]> {
  const ids = [...new Set(rows.map((r) => r.teamId))];
  if (ids.length === 0) return [];
  const who = new Map(
    (
      await db
        .select({
          teamId: teams.id,
          name: teams.name,
          username: users.displayUsername,
          handle: users.username,
          status: profiles.status,
        })
        .from(teams)
        .innerJoin(users, eq(users.id, teams.userId))
        .leftJoin(profiles, eq(profiles.userId, teams.userId))
        .where(inArray(teams.id, ids))
    ).map((r) => [r.teamId, r]),
  );
  const last = new Map(
    (
      await db
        .select({
          teamId: teamEventTotals.teamId,
          points: teamEventTotals.points,
        })
        .from(teamEventTotals)
        .where(
          and(
            eq(teamEventTotals.eventId, throughEventId),
            inArray(teamEventTotals.teamId, ids),
          ),
        )
    ).map((r) => [r.teamId, r.points]),
  );
  return rows.map((r) => {
    const w = who.get(r.teamId);
    const deleted = !w || w.status === "deleted";
    return {
      teamId: r.teamId,
      rank: r.rank,
      move: r.previousRank === null ? null : r.previousRank - r.rank,
      teamName: deleted ? "Deleted team" : w.name,
      username: deleted ? null : (w.username ?? w.handle ?? null),
      points: r.points,
      last: last.get(r.teamId) ?? null,
      mine: mine.has(r.teamId),
    };
  });
}

export const getStandingsInput = z.object({
  slug: z.string().min(1).max(200),
  afterRank: z.number().int().min(0).optional(),
  version: z.string().max(100).nullable().optional(),
  show: z.array(z.uuid()).max(10).optional(),
});

/** `/leagues/$slug` for the signed-in viewer, in the current game. */
export async function standingsForViewer(
  db: Db,
  now: Date,
  viewer: Viewer | null,
  input: z.infer<typeof getStandingsInput>,
): Promise<StandingsPage> {
  const v = requireComplete(viewer);
  const game = await currentGame(db);
  if (!game) throw new GameError("league_not_found", "No current game");
  return standingsPage(db, now, {
    gameId: game.id,
    slug: input.slug,
    reader: readerOf(v),
    afterRank: input.afterRank,
    version: input.version,
    show: input.show,
  });
}
