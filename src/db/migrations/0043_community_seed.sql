-- The forum's seven categories (HLD §7.1), in wave 4's order and words.
-- Admins can rename, reorder or archive them later. Starting a thread needs
-- TL1 (HLD §7.4).
INSERT INTO "categories" ("id", "slug", "name", "description", "position", "kind") VALUES
  (gen_random_uuid(), 'race-weekend', 'Race Weekend', 'A thread for every session, live chat while it runs', 1, 'race_weekend'),
  (gen_random_uuid(), 'fantasy', 'Fantasy', 'Picks, chips, prices and league banter', 2, 'fantasy'),
  (gen_random_uuid(), 'teams-and-drivers', 'Teams & Drivers', 'One home per team and driver', 3, 'general'),
  (gen_random_uuid(), 'technical', 'Technical', 'Upgrades, setups, regulations', 4, 'general'),
  (gen_random_uuid(), 'silly-season', 'Silly Season', 'Rumors and seat moves', 5, 'general'),
  (gen_random_uuid(), 'general', 'General', 'Everything else about the sport', 6, 'general'),
  (gen_random_uuid(), 'off-topic', 'Off-topic', 'Not about racing at all', 7, 'general');
