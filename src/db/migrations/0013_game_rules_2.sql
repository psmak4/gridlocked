-- More rules Drizzle cannot express for the fantasy core (DM Part 3). The
-- tables and CHECKs are in the generated migration before this one.

-- The price freeze (DM 3.5): an event's prices are frozen once its game event
-- has locked, so what a team paid can always be explained. That covers every
-- write (a price cannot be changed, added or removed after the lock), and
-- `carryPrices` has to run before the event locks. Frozen means a game_events
-- row in status locked, scored or final for the asset's game.
CREATE FUNCTION "asset_price_is_frozen"(asset uuid, event uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM "pool_assets" a
    JOIN "game_events" ge ON ge."game_id" = a."game_id"
    WHERE a."id" = asset
      AND ge."event_id" = event
      AND ge."status" IN ('locked', 'scored', 'final')
  );
$$;
--> statement-breakpoint

-- An insert checks the event it adds to, a delete the event it leaves, and an
-- update both (a price can be moved to another asset or event).
CREATE FUNCTION "asset_prices_freeze"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE')
     AND "asset_price_is_frozen"(OLD."asset_id", OLD."event_id") THEN
    RAISE EXCEPTION 'prices are frozen: asset_prices % refused', TG_OP
      USING ERRCODE = 'restrict_violation',
            DETAIL = format('event %s has locked', OLD."event_id");
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE')
     AND "asset_price_is_frozen"(NEW."asset_id", NEW."event_id") THEN
    RAISE EXCEPTION 'prices are frozen: asset_prices % refused', TG_OP
      USING ERRCODE = 'restrict_violation',
            DETAIL = format('event %s has locked', NEW."event_id");
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "asset_prices_freeze"
  BEFORE INSERT OR UPDATE OR DELETE ON "asset_prices"
  FOR EACH ROW EXECUTE FUNCTION "asset_prices_freeze"();
