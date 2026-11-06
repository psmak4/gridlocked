-- team_base_lines (DM 4.3), rebuilt so it filters before it aggregates. It
-- joined asset_session_totals, a GROUP BY over every line of the game, which
-- can't be limited by the lock records being read: each read paid for the
-- whole ledger, and the daily score check (checkScoreExplanations) paid it once
-- per lock record when the planner chose a nested loop. Each base line now sums
-- its own (game, session, asset) lines through the unique index. Same columns
-- and same rows: the sum of the same lines, and no row for an asset with none.
CREATE OR REPLACE VIEW "team_base_lines" AS
SELECT
    s.game_id,
    s.team_id,
    s.event_id,
    se.id AS session_id,
    p.asset_id,
    t.points
FROM "team_event_states" s
JOIN "sessions" se ON se.event_id = s.event_id
LEFT JOIN "lineup_versions" ff ON ff.id = s.final_fix_version_id
LEFT JOIN "sessions" ffs ON ffs.id = ff.effective_from_session_id
CROSS JOIN LATERAL (
    SELECT CASE
             WHEN ffs.id IS NOT NULL
              AND (se.scheduled_start, se.id) >= (ffs.scheduled_start, ffs.id)
             THEN ff.id
             ELSE s.locked_version_id
           END AS version_id
) v
JOIN "lineup_picks" p ON p.lineup_version_id = v.version_id
CROSS JOIN LATERAL (
    SELECT sum(l.points)::integer AS points
    FROM "asset_score_lines" l
    WHERE l.game_id = s.game_id AND l.session_id = se.id AND l.asset_id = p.asset_id
    GROUP BY l.asset_id
) t;
