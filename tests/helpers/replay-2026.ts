// Test helper for tests outside src/providers: the 2026 replays, over the
// recorded fixtures. Like the other helpers it may import src/providers.
import { fileURLToPath } from "node:url";
import { replayWeekend, type ReplayOptions } from "@/providers/replay/harness";
import { replaySeasonGame } from "@/providers/replay/season-game";
import type { TickDb } from "@/jobs/tick";

const FIXTURES = fileURLToPath(new URL("../fixtures", import.meta.url));

/** One recorded weekend of 2026 (`replayWeekend`). */
export const replayRound = (
  db: TickDb,
  round: number,
  options: Omit<ReplayOptions, "season" | "round" | "fixturesDir"> = {},
) =>
  replayWeekend(db, { season: 2026, round, fixturesDir: FIXTURES, ...options });

export { replaySeasonGame };
