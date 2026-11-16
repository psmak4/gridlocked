/**
 * The refusal a fantasy server function sends back for a screen to show.
 *
 * Kept apart from `src/server/play-actions.ts` on purpose: route files import
 * `isRefusal`, so this module ships to the browser. It must import nothing
 * that reaches the database (the schema, `reveal.ts`, Drizzle), or that code
 * ships with it. CI greps the client build for Drizzle to keep it that way.
 */
import { GameError, type GameErrorCode } from "@/game/errors";

/** A refusal a screen can show, in wave 2's words. */
export type Refusal = { ok: false; error: GameErrorCode };

/** True for a refusal, so a loader can tell one from its answer. */
export function isRefusal(value: unknown): value is Refusal {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { ok?: unknown }).ok === false
  );
}

/**
 * Runs `fn`, turning a `GameError` into `{ ok: false, error }`. Anything else
 * is thrown on, for M5's middleware to send as `server_error`.
 */
export async function refusalOf<T>(fn: () => Promise<T>): Promise<T | Refusal> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof GameError) return { ok: false, error: error.code };
    throw error;
  }
}
