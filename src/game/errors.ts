/**
 * Why the game layer refused something a player asked for. Later tasks add
 * codes to the union. Anything that is a bug or missing data stays a plain
 * `Error`.
 */
export type GameErrorCode =
  | "game_not_open"
  | "no_free_slot"
  | "bad_name"
  | "window_closed"
  | "composition"
  | "asset_unavailable"
  | "over_budget"
  | "chip_unavailable"
  | "chip_window_closed";

export class GameError extends Error {
  readonly code: GameErrorCode;

  constructor(code: GameErrorCode, message: string) {
    super(message);
    this.name = "GameError";
    this.code = code;
  }
}

/**
 * The SQLSTATE each game trigger refusal raises (game_rules_4, GL004 from
 * game_rules_5, GL006 and GL007 from game_rules_7), and what it means.
 */
const REFUSALS: Record<string, GameErrorCode> = {
  GL001: "window_closed",
  GL002: "composition",
  GL003: "asset_unavailable",
  GL004: "over_budget",
  GL006: "chip_unavailable",
  GL007: "chip_window_closed",
};
const UNIQUE_VIOLATION = "23505";
/**
 * The unique indexes a chip limit rests on: once per season and one per race
 * (`chip_plays`), and one Late Call version per team and event.
 */
const CHIP_LIMITS = [
  "chip_plays_team_id_chip_code_played_unique",
  "chip_plays_team_id_event_id_played_unique",
  "lineup_versions_team_id_for_event_id_final_fix_unique",
];

/**
 * Turns a database refusal into a `GameError`. Drivers wrap the Postgres error
 * as the `cause` of their own, so the SQLSTATE is looked for down the chain.
 * A unique violation on a chip limit (`CHIP_LIMITS`) is a chip already played
 * this season, another one played for the race, or a second Late Call version
 * for the event. Anything else is returned as it came.
 */
export function refusal(error: unknown): unknown {
  for (
    let e: unknown = error;
    e instanceof Error || (typeof e === "object" && e !== null);
    e = (e as { cause?: unknown }).cause
  ) {
    const { code, constraint } = e as { code?: unknown; constraint?: unknown };
    const message = e instanceof Error ? e.message : "";
    const mapped = typeof code === "string" ? REFUSALS[code] : undefined;
    if (mapped) {
      return new GameError(
        mapped,
        (message || mapped).replace(/^(lineup|chip): /, ""),
      );
    }
    const names = `${typeof constraint === "string" ? constraint : ""} ${message}`;
    if (
      code === UNIQUE_VIOLATION &&
      CHIP_LIMITS.some((name) => names.includes(name))
    ) {
      return new GameError(
        "chip_unavailable",
        "that chip is played already, or another one is for this race",
      );
    }
  }
  return error;
}
