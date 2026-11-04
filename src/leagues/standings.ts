import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { gameEvents } from "@/db/schema";
import type { Db } from "@/db/types";

// League standings (DM 4.7): `league_standings`, rebuilt from
// `team_event_totals` in set-based SQL, so the work is one statement however
// many leagues and members there are. Reads totals, teams and memberships and
// writes only its own table (DM 0.5).

const resultSchema = z.object({ leagues: z.number() });

/**
 * Rebuilds the table of every active league of the game, except `global`,
 * whose range includes the game event `eventId`, and returns how many leagues
 * that is. One transaction and one statement do the work. A league's range is
 * `start_sequence` to `end_sequence` (null: no end), and its table runs over
 * the range up to the latest event in it that has totals, the through event.
 * - **Who is in it:** the current members (`left_at` null) whose team is
 *   `active`. A retired team, or one that left, has no row. A team with no
 *   totals in the range has none either.
 * - **Points** are the sum of the member team's `team_event_totals.points` for
 *   the events in the range, whenever it joined: a member who joined late
 *   ranks on the whole range, like the official mini-leagues.
 * - **The tiebreak** (`first_reached_sequence`) is computed within the range:
 *   the earliest sequence in it at which the team's running total over the
 *   range was at least its total now, so a dip in a negative week is not
 *   "first equal" (DM 4.4).
 * - **`rank`** is `rank()` over the league by points, then the tiebreak, so a
 *   full tie shares a rank and the next rank skips.
 * - **`previous_rank`** is the team's rank in the table it replaces, when that
 *   table ran through a different event. A rebuild through the same event (a
 *   correction) keeps the `previous_rank` it had, so the arrow shows the
 *   movement since the last event, not since the last rebuild. A team that was
 *   not in the old table has none.
 * - **`status`** is `final` once the through event is, else `provisional`.
 *
 * A team that is no longer in the league is deleted from the table, and a
 * league with no totals in its range is emptied. Takes a lock on the game's
 * standings, so two rebuilds of one game take turns. Throws for an event that
 * is not in the game or has no sequence (cancelled). Run again with nothing
 * changed, it writes the same rows.
 */
export async function recomputeStandings(
  db: Db,
  _now: Date,
  input: { gameId: string; eventId: string },
): Promise<{ leagues: number }> {
  const { gameId, eventId } = input;
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`standings:${gameId}`}, 0))`,
    );
    const [event] = await tx
      .select({ sequence: gameEvents.sequence, status: gameEvents.status })
      .from(gameEvents)
      .where(
        and(eq(gameEvents.gameId, gameId), eq(gameEvents.eventId, eventId)),
      );
    if (!event) {
      throw new Error(`recomputeStandings: no event ${eventId} in ${gameId}`);
    }
    if (event.sequence === null) {
      throw new Error(
        `recomputeStandings: event ${eventId} is ${event.status} and has no sequence`,
      );
    }
    const game = sql`${gameId}::uuid`;
    const sequence = sql`${event.sequence}::integer`;

    const { rows } = (await tx.execute(sql`
      with target as (
        select l.id, l.start_sequence, l.end_sequence
        from leagues l
        where l.game_id = ${game} and l.status = 'active' and l.kind <> 'global'
          and l.start_sequence <= ${sequence}
          and (l.end_sequence is null or l.end_sequence >= ${sequence})
      ), rows as (
        select t.id as league_id, m.team_id, x.event_sequence, x.points
        from target t
        join league_memberships m on m.league_id = t.id and m.left_at is null
        join teams tm on tm.id = m.team_id and tm.status = 'active'
        join team_event_totals x on x.team_id = m.team_id
          and x.event_sequence >= t.start_sequence
          and (t.end_sequence is null or x.event_sequence <= t.end_sequence)
      ), through as (
        select league_id, max(event_sequence) as sequence
        from rows
        group by league_id
      ), running as (
        select league_id, team_id, event_sequence,
               sum(points) over (partition by league_id, team_id order by event_sequence)::integer as cumulative
        from rows
      ), totals as (
        select distinct on (league_id, team_id) league_id, team_id, cumulative as points
        from running
        order by league_id, team_id, event_sequence desc
      ), reached as (
        select r.league_id, r.team_id, min(r.event_sequence) as first_reached
        from running r
        join totals f on f.league_id = r.league_id and f.team_id = r.team_id
        where r.cumulative >= f.points
        group by r.league_id, r.team_id
      ), ranked as (
        select f.league_id, f.team_id, f.points, k.first_reached,
               rank() over (partition by f.league_id order by f.points desc, k.first_reached asc)::integer as rank
        from totals f
        join reached k on k.league_id = f.league_id and k.team_id = f.team_id
      ), fresh as (
        select r.league_id, r.team_id, r.points, r.first_reached, r.rank,
               case when s.team_id is null then null
                    when s.through_event_id <> ge.event_id then s.rank
                    else s.previous_rank end as previous_rank,
               ge.event_id as through_event_id,
               case when ge.status = 'final' then 'final' else 'provisional' end as status
        from ranked r
        join through h on h.league_id = r.league_id
        join game_events ge on ge.game_id = ${game} and ge.sequence = h.sequence
        left join league_standings s on s.league_id = r.league_id and s.team_id = r.team_id
      ), removed as (
        delete from league_standings s
        where s.league_id in (select id from target)
          and not exists (
            select 1 from fresh f where f.league_id = s.league_id and f.team_id = s.team_id
          )
        returning s.team_id
      ), written as (
        insert into league_standings (
          league_id, team_id, points, first_reached_sequence, rank, previous_rank,
          through_event_id, status
        )
        select league_id, team_id, points, first_reached, rank, previous_rank,
               through_event_id, status
        from fresh
        on conflict (league_id, team_id) do update set
          points = excluded.points,
          first_reached_sequence = excluded.first_reached_sequence,
          rank = excluded.rank,
          previous_rank = excluded.previous_rank,
          through_event_id = excluded.through_event_id,
          status = excluded.status
        returning team_id
      )
      select (select count(*) from target)::integer as leagues
    `)) as { rows: unknown[] };
    return resultSchema.parse(rows[0]);
  });
}
