-- The forum's seven categories (HLD §7.1; M7's calls). Admins can rename,
-- reorder or archive them later. Starting a thread needs TL1 (HLD §7.4).
INSERT INTO "categories" ("id", "slug", "name", "description", "position", "kind") VALUES
  (gen_random_uuid(), 'race-weekend', 'Race Weekend', 'Session threads, live chat and results, one weekend at a time.', 1, 'race_weekend'),
  (gen_random_uuid(), 'general', 'General', 'Anything about the sport.', 2, 'general'),
  (gen_random_uuid(), 'fantasy', 'Fantasy', 'Picks, chips, prices and leagues.', 3, 'fantasy'),
  (gen_random_uuid(), 'teams-and-drivers', 'Teams & Drivers', 'The grid, the people on it and the teams behind them.', 4, 'general'),
  (gen_random_uuid(), 'technical', 'Technical', 'Cars, rules, tyres and strategy.', 5, 'general'),
  (gen_random_uuid(), 'silly-season', 'Silly Season', 'Seats, contracts and rumours.', 6, 'general'),
  (gen_random_uuid(), 'off-topic', 'Off-topic', 'Everything else.', 7, 'general');
