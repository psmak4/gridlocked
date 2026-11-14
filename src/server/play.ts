/**
 * The fantasy server functions (M6). Each is a `createServerFn` with a Zod
 * `validator` for its input, whose handler calls `playAction`: the answer is
 * private, the viewer and the request's clock are read once, and a game
 * refusal comes back as `{ ok: false, error }` for the screen to put in
 * words. The work is in `play-actions.ts` and `src/play/`.
 *
 * `createServerFn(...).validator(...).handler(...)` stays written out at the
 * top level of this file for each function: Start's compiler finds server
 * functions there, so a factory around it would hide them.
 */
import { createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import type { Viewer } from "@/identity/viewer";
import { currentGame, type CurrentGame } from "@/play/current-game";
import { withDb, type ServerDb } from "./db";
import {
  markSessionsWatchedAction,
  markSessionsWatchedInput,
  refusalOf,
  type Refusal,
} from "./play-actions";
import { getViewer, withRequestNow } from "./session";

/**
 * A fantasy server function's body: `Cache-Control: private, no-store`
 * (every answer is about the viewer, ruling 51e), the viewer from the
 * request cookie, the request's "now" (HLD decision 20), and a `GameError`
 * turned into `{ ok: false, error }`. The guard (`requireComplete` for a
 * read, `requireWritable` for a write) is the action's own first line.
 */
// Not exported: only the handlers below use it, so the client build drops it
// with them (a route's import of this file would otherwise pull in
// `@tanstack/react-start/server`).
async function playAction<T>(
  fn: (db: ServerDb, now: Date, viewer: Viewer | null) => Promise<T>,
): Promise<T | Refusal> {
  setResponseHeader("Cache-Control", "private, no-store");
  const viewer = await getViewer(getRequest());
  return refusalOf(() => withRequestNow((db, now) => fn(db, now, viewer)));
}

/** "Mark as watched" on the hub, the breakdown and the locked team (DM 5.7). */
export const markSessionsWatched = createServerFn({ method: "POST" })
  .validator(markSessionsWatchedInput)
  .handler(({ data }) =>
    playAction((db, now, viewer) =>
      markSessionsWatchedAction(db, now, viewer, data),
    ),
  );

/** Each request's answer, so the loaders of one page read it once. */
const currentGameByRequest = new WeakMap<
  Request,
  Promise<CurrentGame | null>
>();

/**
 * The season's game, or null before it opens (`<NoGame />`). The same for
 * everyone, so it is read without the viewer, once per request.
 */
export const getCurrentGame = createServerFn({ method: "GET" }).handler(
  (): Promise<CurrentGame | null> => {
    const request = getRequest();
    let found = currentGameByRequest.get(request);
    if (!found) {
      found = withDb((db) => currentGame(db));
      currentGameByRequest.set(request, found);
    }
    return found;
  },
);
