-- Rules Drizzle cannot express for the ledger (DM Part 4). The tables, CHECKs
-- and indexes are in the generated migration before this one.

-- asset_session_totals (DM 4.2): each asset's points in a session, and its
-- points by rule category, from the session's lines (the current run's; a
-- re-score replaces them). A category's subtotal is every line of it, so a
-- constructor's sums both its drivers' copied lines together, and Safety Car
-- floors that combined subtotal. An asset with no lines has no row: it scored
-- 0. Team math and the price formula read it.
CREATE VIEW "asset_session_totals" AS
SELECT
    c.game_id,
    c.session_id,
    c.asset_id,
    sum(c.points)::integer AS points,
    jsonb_object_agg(c.category, c.points) AS by_category
FROM (
    SELECT l.game_id, l.session_id, l.asset_id, l.category, sum(l.points)::integer AS points
    FROM "asset_score_lines" l
    GROUP BY l.game_id, l.session_id, l.asset_id, l.category
) c
GROUP BY c.game_id, c.session_id, c.asset_id;
--> statement-breakpoint

-- team_base_lines (DM 4.3): the base of a team's score, with no storage. For
-- each lock record (team_event_states), session of its event and asset of
-- that session's effective lineup with a total there, the asset's session
-- points. The effective lineup is the locked version, or the Late Call version
-- (final_fix_version_id) from the session it applies from, the race, on: by
-- (scheduled_start, id), the order the adjustments use (effectiveLineup). A
-- straight join on asset_session_totals, so base lines can't disagree with
-- the asset scores, and only scored sessions have rows.
CREATE VIEW "team_base_lines" AS
SELECT
    s.game_id,
    s.team_id,
    s.event_id,
    t.session_id,
    t.asset_id,
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
JOIN "asset_session_totals" t
  ON t.game_id = s.game_id AND t.session_id = se.id AND t.asset_id = p.asset_id;
