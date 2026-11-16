/**
 * Leagues on the fantasy screens (M6 Task 12): the viewer's leagues, and
 * creating, joining and leaving one. The rules are the game layer's
 * (`src/leagues/leagues.ts`); this adds who may, rounds in place of event
 * sequences, the join-code rate limit and the spoiler check on ranks.
 */
import { and, asc, count, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import {
  LEAGUE_NAME_MAX,
  events,
  gameEvents,
  leagueMemberships,
  leagueStandings,
  leagues,
  sessions,
  teamEventTotals,
  teams,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { GameError } from "@/game/errors";
import {
  consumeRateLimit,
  requireComplete,
  requireWritable,
  type Viewer,
} from "@/identity/viewer";
import { createLeague, joinLeague, leaveLeague } from "@/leagues/leagues";
import { SCORED_KINDS } from "@/results/validate";
import { refusalOf, type Refusal } from "@/play/refusal";
import { getSetting } from "@/settings";
import { revealedSessions, type Reader } from "@/spoilers/reveal";
import { currentGame, type CurrentGame } from "./current-game";
import { myTeams, ownTeam } from "./teams";
import { readerOf } from "./weekend";

type LeagueKind = (typeof leagues.$inferSelect)["kind"];

/** One of the viewer's teams in one league. */
export type LeagueRow = {
  leagueId: string;
  slug: string;
  /** "Everyone" for the global league. */
  name: string;
  kind: LeagueKind;
  teamId: string;
  teamName: string;
  /**
   * The team's rank, and its move since the event before ("▲3" is 3):
   * null before anything is scored, and while the table's latest event
   * is hidden from the viewer (M6 decision 2).
   */
  rank: number | null;
  move: number | null;
  /** The table's latest event is hidden: the rank is covered. */
  hidden: boolean;
  /** Current members with an active team. */
  members: number;
  /** A mini-league's rounds; null for the whole season. */
  rounds: { from: number; to: number | null } | null;
  /** For a public or private league: its code, to invite with. */
  joinCode: string | null;
  /** Run by the viewer. */
  mine: boolean;
};

export type MyLeagues = {
  /** Public and private leagues the viewer's teams joined. */
  yours: LeagueRow[];
  /** The global league first, then the ones the profile puts teams in. */
  automatic: LeagueRow[];
};

/**
 * The events, of those given, with a scored session the reader hasn't seen:
 * a table through one of them is covered (decision 2).
 */
export async function hiddenEvents(
  db: Db,
  now: Date,
  reader: Reader,
  eventIds: string[],
): Promise<Set<string>> {
  const ids = [...new Set(eventIds)];
  if (ids.length === 0) return new Set();
  const scored = await db
    .select({ id: sessions.id, eventId: sessions.eventId })
    .from(sessions)
    .where(
      and(
        inArray(sessions.eventId, ids),
        inArray(sessions.kind, [...SCORED_KINDS]),
      ),
    );
  const revealed = await revealedSessions(
    db,
    now,
    reader,
    scored.map((s) => s.id),
  );
  return new Set(
    scored.filter((s) => !revealed.has(s.id)).map((s) => s.eventId),
  );
}

/** Rounds for a game's event sequences, and back. */
async function roundsOf(db: Db, gameId: string) {
  const rows = await db
    .select({
      sequence: gameEvents.sequence,
      round: events.round,
      name: events.name,
      status: gameEvents.status,
    })
    .from(gameEvents)
    .innerJoin(events, eq(events.id, gameEvents.eventId))
    .where(eq(gameEvents.gameId, gameId))
    .orderBy(asc(events.round));
  return rows;
}

/**
 * The viewer's leagues in a game, one row per league and team: the public
 * and private ones their teams joined, then the global league and the auto
 * leagues. Ranks come from the stored tables (`league_standings`, and
 * `team_event_totals` for the global one).
 */
export async function myLeagues(
  db: Db,
  now: Date,
  input: { gameId: string; userId: string; reader: Reader },
): Promise<MyLeagues> {
  const active = (await myTeams(db, input)).filter(
    (t) => t.status === "active",
  );
  if (active.length === 0) return { yours: [], automatic: [] };
  const teamIds = active.map((t) => t.id);
  const teamName = new Map(active.map((t) => [t.id, t.name]));

  const joined = await db
    .select({
      leagueId: leagues.id,
      slug: leagues.slug,
      name: leagues.name,
      kind: leagues.kind,
      ownerUserId: leagues.ownerUserId,
      joinCode: leagues.joinCode,
      startSequence: leagues.startSequence,
      endSequence: leagues.endSequence,
      teamId: leagueMemberships.teamId,
      joinedAt: leagueMemberships.joinedAt,
    })
    .from(leagueMemberships)
    .innerJoin(leagues, eq(leagues.id, leagueMemberships.leagueId))
    .where(
      and(
        inArray(leagueMemberships.teamId, teamIds),
        isNull(leagueMemberships.leftAt),
        eq(leagues.gameId, input.gameId),
        eq(leagues.status, "active"),
      ),
    )
    .orderBy(asc(leagueMemberships.joinedAt), asc(leagues.name));
  const [global] = await db
    .select({ id: leagues.id, slug: leagues.slug })
    .from(leagues)
    .where(and(eq(leagues.gameId, input.gameId), eq(leagues.kind, "global")));

  const leagueIds = [...new Set(joined.map((j) => j.leagueId))];
  const members = new Map(
    leagueIds.length === 0
      ? []
      : (
          await db
            .select({ leagueId: leagueMemberships.leagueId, n: count() })
            .from(leagueMemberships)
            .innerJoin(teams, eq(teams.id, leagueMemberships.teamId))
            .where(
              and(
                inArray(leagueMemberships.leagueId, leagueIds),
                isNull(leagueMemberships.leftAt),
                eq(teams.status, "active"),
              ),
            )
            .groupBy(leagueMemberships.leagueId)
        ).map((row) => [row.leagueId, row.n]),
  );
  const standings =
    leagueIds.length === 0
      ? []
      : await db
          .select({
            leagueId: leagueStandings.leagueId,
            teamId: leagueStandings.teamId,
            rank: leagueStandings.rank,
            previousRank: leagueStandings.previousRank,
            throughEventId: leagueStandings.throughEventId,
          })
          .from(leagueStandings)
          .where(
            and(
              inArray(leagueStandings.leagueId, leagueIds),
              inArray(leagueStandings.teamId, teamIds),
            ),
          );
  const standingOf = (leagueId: string, teamId: string) =>
    standings.find((s) => s.leagueId === leagueId && s.teamId === teamId);

  // The global table: each team's latest event total, and its rank before.
  const latest = await db
    .select({
      teamId: teamEventTotals.teamId,
      eventId: teamEventTotals.eventId,
      rank: teamEventTotals.globalRank,
      sequence: teamEventTotals.eventSequence,
    })
    .from(teamEventTotals)
    .where(inArray(teamEventTotals.teamId, teamIds))
    .orderBy(desc(teamEventTotals.eventSequence));
  const globalOf = (teamId: string) => {
    const rows = latest.filter((r) => r.teamId === teamId);
    return { now: rows[0], before: rows[1] };
  };
  const [{ n: everyone } = { n: 0 }] = await db
    .select({ n: count() })
    .from(teams)
    .where(and(eq(teams.gameId, input.gameId), eq(teams.status, "active")));

  const hidden = await hiddenEvents(db, now, input.reader, [
    ...standings.map((s) => s.throughEventId),
    ...latest.map((r) => r.eventId),
  ]);
  const rounds = await roundsOf(db, input.gameId);
  const roundAt = (sequence: number | null) =>
    sequence === null
      ? null
      : (rounds.find((r) => r.sequence === sequence)?.round ?? null);

  const row = (j: (typeof joined)[number]): LeagueRow => {
    const standing = standingOf(j.leagueId, j.teamId);
    const covered =
      standing !== undefined && hidden.has(standing.throughEventId);
    const mini = j.startSequence !== 1 || j.endSequence !== null;
    return {
      leagueId: j.leagueId,
      slug: j.slug,
      name: j.name,
      kind: j.kind,
      teamId: j.teamId,
      teamName: teamName.get(j.teamId) ?? "",
      rank: standing && !covered ? standing.rank : null,
      move:
        standing && !covered && standing.previousRank !== null
          ? standing.previousRank - standing.rank
          : null,
      hidden: covered,
      members: members.get(j.leagueId) ?? 0,
      rounds: mini
        ? {
            from: roundAt(j.startSequence) ?? j.startSequence,
            to: roundAt(j.endSequence),
          }
        : null,
      joinCode: j.joinCode,
      mine: j.ownerUserId === input.userId,
    };
  };

  const yours = joined
    .filter((j) => j.kind === "public" || j.kind === "private")
    .map(row);
  const auto = joined
    .filter((j) => j.kind !== "public" && j.kind !== "private")
    .map(row);
  const globals: LeagueRow[] = global
    ? active.map((team) => {
        const { now: at, before } = globalOf(team.id);
        const covered = at !== undefined && hidden.has(at.eventId);
        return {
          leagueId: global.id,
          slug: global.slug,
          name: "Everyone",
          kind: "global" as const,
          teamId: team.id,
          teamName: team.name,
          rank: at && !covered ? at.rank : null,
          move: at && before && !covered ? before.rank - at.rank : null,
          hidden: covered,
          members: everyone,
          rounds: null,
          joinCode: null,
          mine: false,
        };
      })
    : [];
  return { yours, automatic: [...globals, ...auto] };
}

/** A round to pick in Create a league. */
export type RoundChoice = { round: number; name: string };

export type LeaguesPage = {
  game: CurrentGame | null;
  leagues: MyLeagues;
  /** The viewer's active teams: which one joins or creates. */
  teams: Array<{ id: string; name: string }>;
  /** Rounds still to come, for a mini-league's From and To. */
  rounds: RoundChoice[];
};

/** `/leagues` and `/leagues/new`: the viewer's leagues and what Create needs. */
export async function leaguesPage(
  db: Db,
  now: Date,
  viewer: Viewer | null,
): Promise<LeaguesPage> {
  const v = requireComplete(viewer);
  const game = await currentGame(db);
  const empty = { yours: [], automatic: [] };
  if (!game) return { game: null, leagues: empty, teams: [], rounds: [] };
  const mine = (await myTeams(db, { gameId: game.id, userId: v.userId }))
    .filter((t) => t.status === "active")
    .map((t) => ({ id: t.id, name: t.name }));
  const rounds = (await roundsOf(db, game.id))
    .filter((r) => r.sequence !== null && r.status !== "final")
    .map((r) => ({ round: r.round, name: r.name }));
  return {
    game,
    leagues: await myLeagues(db, now, {
      gameId: game.id,
      userId: v.userId,
      reader: readerOf(v),
    }),
    teams: mine,
    rounds,
  };
}

export const createLeagueInput = z.object({
  teamId: z.uuid(),
  // The length is the game layer's check (`bad_name`); this only keeps an
  // absurd input out.
  name: z.string().max(200),
  kind: z.enum(["public", "private"]),
  startRound: z.number().int().min(1).max(30).optional(),
  endRound: z.number().int().min(1).max(30).optional(),
});

/**
 * Creates a public or private league with the viewer's team in it, in one
 * transaction. Rounds become the events' sequences; a round with none (a
 * cancelled one) or a range that ends before it starts is `bad_range`.
 */
export function createLeagueAction(
  db: Db,
  now: Date,
  viewer: Viewer | null,
  data: z.infer<typeof createLeagueInput>,
): Promise<{ ok: true; slug: string; joinCode: string } | Refusal> {
  const v = requireWritable(viewer);
  return refusalOf(async () => {
    const game = await currentGame(db);
    if (!game) throw new GameError("game_not_open", "no game is open");
    const team = await ownTeam(db, v.userId, data.teamId);
    if (team.gameId !== game.id) {
      throw new GameError("team_not_owned", "not a team in this game");
    }
    if (team.status === "retired") {
      throw new GameError("team_retired", "a retired team can't join");
    }
    const name = data.name.trim();
    if (
      Array.from(name).length < 1 ||
      Array.from(name).length > LEAGUE_NAME_MAX
    ) {
      throw new GameError("bad_name", "a league name is 1 to 40 characters");
    }
    const rounds = await roundsOf(db, game.id);
    const sequenceOf = (round: number | undefined) => {
      if (round === undefined) return undefined;
      const sequence = rounds.find((r) => r.round === round)?.sequence;
      if (sequence === null || sequence === undefined) {
        throw new GameError("bad_range", `round ${round} isn't in the game`);
      }
      return sequence;
    };
    const startSequence = sequenceOf(data.startRound);
    const endSequence = sequenceOf(data.endRound);
    if (
      startSequence !== undefined &&
      endSequence !== undefined &&
      endSequence < startSequence
    ) {
      throw new GameError("bad_range", "the last round is before the first");
    }
    return db.transaction(async (tx) => {
      const t = tx as unknown as Db;
      const { leagueId, joinCode } = await createLeague(t, now, {
        gameId: game.id,
        ownerUserId: v.userId,
        kind: data.kind,
        name,
        startSequence,
        endSequence,
      });
      await joinLeague(t, now, {
        joinCode,
        teamId: data.teamId,
        userId: v.userId,
      });
      const [made] = await t
        .select({ slug: leagues.slug })
        .from(leagues)
        .where(eq(leagues.id, leagueId));
      return { ok: true as const, slug: made!.slug, joinCode };
    });
  });
}

export const joinLeagueInput = z.object({
  code: z.string().max(40),
  teamId: z.uuid(),
});

/**
 * Joins a league by its code, for one of the viewer's teams. Each try counts
 * against `league_join_limit` first, a right code included, so codes can't
 * be guessed (Review Focus 5). Spaces and dashes in the code are ignored,
 * and its case.
 */
export function joinLeagueAction(
  db: Db,
  now: Date,
  viewer: Viewer | null,
  data: z.infer<typeof joinLeagueInput>,
): Promise<{ ok: true; slug: string; name: string } | Refusal> {
  const v = requireWritable(viewer);
  return refusalOf(async () => {
    const limit = await getSetting(db, "league_join_limit");
    if (!(await consumeRateLimit(db, now, `league_join:${v.userId}`, limit))) {
      throw new GameError("rate_limited", "too many tries at a join code");
    }
    const code = data.code.replace(/[\s-]+/g, "").toUpperCase();
    const { leagueId } = await joinLeague(db, now, {
      joinCode: code,
      teamId: data.teamId,
      userId: v.userId,
    });
    const [league] = await db
      .select({ slug: leagues.slug, name: leagues.name })
      .from(leagues)
      .where(eq(leagues.id, leagueId));
    return { ok: true as const, slug: league!.slug, name: league!.name };
  });
}

export const leaveLeagueInput = z.object({
  leagueId: z.uuid(),
  teamId: z.uuid(),
});

/** Takes one of the viewer's teams out of a public or private league. */
export function leaveLeagueAction(
  db: Db,
  now: Date,
  viewer: Viewer | null,
  data: z.infer<typeof leaveLeagueInput>,
): Promise<{ ok: true } | Refusal> {
  const v = requireWritable(viewer);
  return refusalOf(async () => {
    await leaveLeague(db, now, { ...data, userId: v.userId });
    return { ok: true as const };
  });
}
