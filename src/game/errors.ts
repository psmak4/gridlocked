/**
 * Why the game layer refused something a player asked for. Later tasks add
 * codes to the union. Anything that is a bug or missing data stays a plain
 * `Error`.
 */
export type GameErrorCode = "game_not_open" | "no_free_slot" | "bad_name";

export class GameError extends Error {
  readonly code: GameErrorCode;

  constructor(code: GameErrorCode, message: string) {
    super(message);
    this.name = "GameError";
    this.code = code;
  }
}
