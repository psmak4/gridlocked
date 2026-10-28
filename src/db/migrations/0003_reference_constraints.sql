-- Constraints Drizzle cannot express (DM 1.3, 1.8). Everything else for the
-- reference tables is in the generated migration before this one.

-- Needed so GiST can index uuid / integer columns with =, next to a range.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint

-- Deferrable so a whole calendar can be renumbered in one transaction
-- (SET CONSTRAINTS ALL DEFERRED). Checked per statement otherwise.
ALTER TABLE "events"
  ADD CONSTRAINT "events_season_id_round_unique"
  UNIQUE ("season_id", "round") DEFERRABLE INITIALLY IMMEDIATE;
--> statement-breakpoint

-- A driver can't hold two race seats over overlapping dates. Ranges are
-- inclusive of valid_to; a null valid_to is open-ended. Reserve seats are
-- exempt.
ALTER TABLE "seat_assignments"
  ADD CONSTRAINT "seat_assignments_driver_race_no_overlap"
  EXCLUDE USING gist (
    "driver_id" WITH =,
    daterange("valid_from", "valid_to", '[]') WITH &&
  ) WHERE ("role" = 'race');
--> statement-breakpoint

-- Two race seats can't use the same car number in a season at the same time.
ALTER TABLE "seat_assignments"
  ADD CONSTRAINT "seat_assignments_car_number_race_no_overlap"
  EXCLUDE USING gist (
    "season_id" WITH =,
    "car_number" WITH =,
    daterange("valid_from", "valid_to", '[]') WITH &&
  ) WHERE ("role" = 'race');
