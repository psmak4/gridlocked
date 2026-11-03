-- Rules Drizzle cannot express for the fantasy core (DM Part 3). The tables
-- and CHECKs are in the generated migration before this one.

-- The ruleset freeze (DM 3.2): a version is frozen once any game event using
-- it has locked, so past scores can always be reproduced exactly. A rule
-- change is a new version from a later event. Frozen means a game_events row
-- with that version in status locked, scored or final. The one exception, an
-- audited correction that re-points past events to a fixed version (DM 4.9),
-- re-points game_events.ruleset_version_id; it never edits a frozen version.
CREATE FUNCTION "ruleset_version_is_frozen"(version_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM "game_events"
    WHERE "ruleset_version_id" = version_id
      AND "status" IN ('locked', 'scored', 'final')
  );
$$;
--> statement-breakpoint

CREATE FUNCTION "ruleset_versions_freeze"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF "ruleset_version_is_frozen"(OLD."id") THEN
    RAISE EXCEPTION 'ruleset version is frozen: % refused', TG_OP
      USING ERRCODE = 'restrict_violation',
            DETAIL = format('ruleset_versions %s is used by a locked event', OLD."id");
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "ruleset_versions_freeze"
  BEFORE UPDATE OR DELETE ON "ruleset_versions"
  FOR EACH ROW EXECUTE FUNCTION "ruleset_versions_freeze"();
--> statement-breakpoint

-- Every write to scoring_rules: an insert checks the version it joins, a delete
-- the version it leaves, and an update both (a rule can be moved to another
-- version).
CREATE FUNCTION "scoring_rules_freeze"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE')
     AND "ruleset_version_is_frozen"(OLD."ruleset_version_id") THEN
    RAISE EXCEPTION 'ruleset version is frozen: scoring_rules % refused', TG_OP
      USING ERRCODE = 'restrict_violation',
            DETAIL = format('ruleset_versions %s is used by a locked event', OLD."ruleset_version_id");
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE')
     AND "ruleset_version_is_frozen"(NEW."ruleset_version_id") THEN
    RAISE EXCEPTION 'ruleset version is frozen: scoring_rules % refused', TG_OP
      USING ERRCODE = 'restrict_violation',
            DETAIL = format('ruleset_versions %s is used by a locked event', NEW."ruleset_version_id");
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "scoring_rules_freeze"
  BEFORE INSERT OR UPDATE OR DELETE ON "scoring_rules"
  FOR EACH ROW EXECUTE FUNCTION "scoring_rules_freeze"();
