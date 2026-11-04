import { eq, and, sql } from "drizzle-orm";
import { z } from "zod";
import { gameEvents } from "@/db/schema";
import type { Db } from "@/db/types";
import { lockLedger } from "./scoring-runs";

// Event totals, running totals and ranks (DM 4.4): `team_event_totals`, built
// from the ledger (`team_base_lines` and `team_adjustment_lines`) in set-based
// SQL, so the work is a few statements however many teams there are. It reads
// the ledger and game data and writes only its own table (DM 0.5).

const resultSchema = z.object({ events: z.number(), teams: z.number() });

/**
 * Rebuilds the totals of the game event `fromEventId` and everything after
 * it, in one transaction, and returns how many events had their running
 * totals recomputed and how many teams' rows for `fromEventId` were written.
 *
 * Under the event's ledger lock, so it never runs between the steps of a
 * scoring run for the event, and a lock of its own on the game's totals: it
 * rewrites the rows of later events too, so two rebuilds of one game take
 * turns whichever event they start from.
 *
 * One statement does the work:
 * - **The event's rows** are one per team with a lock record for it
 *   (`team_event_states`): `points` is the team's base lines plus its
 *   adjustment lines, the event-level ones (the transfer penalty) included,
 *   and `points_by_session` has an entry for each scored session (a current
 *   run), base plus that session's adjustments. A row for a team whose lock
 *   record is gone is deleted.
 * - **The running total** at an event is the team's sum over its rows up to
 *   that sequence; a cancelled event has no rows, so it carries straight on.
 * - **`first_reached_sequence`** is the earliest sequence at which the running
 *   total was at least today's: the total can dip in a negative week, so it
 *   is not the first time it was equal.
 * - **`global_rank`** is `rank()` over the game's rows at the event by running
 *   total, then `first_reached_sequence`, so ties share a rank.
 *
 * Running totals, firsts and ranks are rewritten for `fromEventId` and every
 * later event by sequence that has rows; those events' `points` are not
 * touched, so a correction to an early event moves the standings after it and
 * leaves what each later event scored. The rows' `status` is `final` once the
 * game event is `final`, otherwise `provisional`. Run again with nothing
 * changed, it writes the same rows.
 *
 * Throws for an event that is not in the game or has no sequence (cancelled).
 */
export async function recomputeTotals(
  db: Db,
  now: Date,
  input: { gameId: string; fromEventId: string },
): Promise<{ events: number; teams: number }> {
  const { gameId, fromEventId } = input;
  return db.transaction(async (tx) => {
    await lockLedger(tx, { gameId, eventId: fromEventId });
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`totals:${gameId}`}, 0))`,
    );
    const [event] = await tx
      .select({ sequence: gameEvents.sequence, status: gameEvents.status })
      .from(gameEvents)
      .where(
        and(eq(gameEvents.gameId, gameId), eq(gameEvents.eventId, fromEventId)),
      );
    if (!event) {
      throw new Error(`recomputeTotals: no event ${fromEventId} in ${gameId}`);
    }
    if (event.sequence === null) {
      throw new Error(
        `recomputeTotals: event ${fromEventId} is ${event.status} and has no sequence`,
      );
    }
    const status = event.status === "final" ? "final" : "provisional";
    const game = sql`${gameId}::uuid`;
    const from = sql`${fromEventId}::uuid`;
    const sequence = sql`${event.sequence}::integer`;

    const { rows } = (await tx.execute(sql`
      with base as (
        select team_id, sum(points)::integer as points
        from team_base_lines
        where game_id = ${game} and event_id = ${from}
        group by team_id
      ), adjustments as (
        select team_id, sum(points)::integer as points
        from team_adjustment_lines
        where game_id = ${game} and event_id = ${from}
        group by team_id
      ), by_session as (
        select s.team_id, jsonb_object_agg(se.id, coalesce(b.points, 0) + coalesce(a.points, 0)) as points
        from team_event_states s
        join sessions se on se.event_id = s.event_id
        join scoring_runs r on r.session_id = se.id and r.game_id = s.game_id and r.is_current
        left join (
          select team_id, session_id, sum(points) as points from team_base_lines
          where game_id = ${game} and event_id = ${from}
          group by team_id, session_id
        ) b on b.team_id = s.team_id and b.session_id = se.id
        left join (
          select team_id, session_id, sum(points) as points from team_adjustment_lines
          where game_id = ${game} and event_id = ${from}
          group by team_id, session_id
        ) a on a.team_id = s.team_id and a.session_id = se.id
        where s.game_id = ${game} and s.event_id = ${from}
        group by s.team_id
      ), rewritten as (
        select s.team_id,
               coalesce(b.points, 0) + coalesce(a.points, 0) as points,
               coalesce(p.points, '{}'::jsonb) as points_by_session
        from team_event_states s
        left join base b on b.team_id = s.team_id
        left join adjustments a on a.team_id = s.team_id
        left join by_session p on p.team_id = s.team_id
        where s.game_id = ${game} and s.event_id = ${from}
      ), ledger as (
        select team_id, event_id, event_sequence, points
        from team_event_totals
        where game_id = ${game} and event_id <> ${from}
        union all
        select team_id, ${from}, ${sequence}, points from rewritten
      ), running as (
        select team_id, event_id, event_sequence,
               sum(points) over (partition by team_id order by event_sequence)::integer as cumulative
        from ledger
      ), reached as (
        select r.team_id, r.event_id, r.event_sequence, r.cumulative,
               min(p.event_sequence) as first_reached
        from running r
        join running p on p.team_id = r.team_id
                      and p.event_sequence <= r.event_sequence
                      and p.cumulative >= r.cumulative
        where r.event_sequence >= ${sequence}
        group by r.team_id, r.event_id, r.event_sequence, r.cumulative
      ), ranked as (
        select team_id, event_id, cumulative, first_reached,
               rank() over (partition by event_id order by cumulative desc, first_reached asc)::integer as global_rank
        from reached
      ), removed as (
        delete from team_event_totals t
        where t.game_id = ${game} and t.event_id = ${from}
          and not exists (select 1 from rewritten w where w.team_id = t.team_id)
        returning t.team_id
      ), written as (
        insert into team_event_totals (
          game_id, team_id, event_id, event_sequence, points, points_by_session,
          cumulative_points, first_reached_sequence, global_rank, status, computed_at
        )
        select ${game}, w.team_id, ${from}, ${sequence}, w.points, w.points_by_session,
               k.cumulative, k.first_reached, k.global_rank,
               ${status}, ${now.toISOString()}::timestamptz
        from rewritten w
        join ranked k on k.team_id = w.team_id and k.event_id = ${from}
        on conflict (team_id, event_id) do update set
          event_sequence = excluded.event_sequence,
          points = excluded.points,
          points_by_session = excluded.points_by_session,
          cumulative_points = excluded.cumulative_points,
          first_reached_sequence = excluded.first_reached_sequence,
          global_rank = excluded.global_rank,
          status = excluded.status,
          computed_at = excluded.computed_at
        returning team_id
      ), moved as (
        update team_event_totals t set
          cumulative_points = k.cumulative,
          first_reached_sequence = k.first_reached,
          global_rank = k.global_rank,
          computed_at = ${now.toISOString()}::timestamptz
        from ranked k
        where t.team_id = k.team_id and t.event_id = k.event_id
          and k.event_id <> ${from}
        returning t.team_id
      )
      select (select count(distinct event_id) from ranked)::integer as events,
             (select count(*) from written)::integer as teams
    `)) as { rows: unknown[] };
    return resultSchema.parse(rows[0]);
  });
}
