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
import {
  builderForSlot,
  getBuilderInput,
  lateCallAction,
  lateCallInput,
  playChipAction,
  playChipInput,
  saveTeamAction,
  saveTeamInput,
} from "@/play/builder";
import { breakdownForSlot, getBreakdownInput } from "@/play/breakdown";
import { currentGame, type CurrentGame } from "@/play/current-game";
import { getHomeInput, homeState } from "@/play/home";
import {
  createLeagueAction,
  createLeagueInput,
  joinLeagueAction,
  joinLeagueInput,
  leaguesPage,
  leaveLeagueAction,
  leaveLeagueInput,
} from "@/play/leagues";
import {
  getPricesInput,
  howPricesPage,
  pricesPage,
  type PriceBoard,
} from "@/play/prices";
import { getStandingsInput, standingsForViewer } from "@/play/standings";
import {
  createTeamAction,
  createTeamInput,
  removeTeamAction,
  removeTeamInput,
  renameTeamAction,
  renameTeamInput,
  teamsPage,
} from "@/play/teams";
import { weekendPage, type WeekendPage } from "@/play/weekend";
import { PUBLIC_CACHE } from "@/lib/public-headers";
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

/** `/team` and the builder's header: the current game and the viewer's teams. */
export const getTeams = createServerFn({ method: "GET" }).handler(() =>
  playAction((db, _now, viewer) => teamsPage(db, viewer)),
);

/** "Create a team": the lowest free slot, and its auto leagues. */
export const createMyTeam = createServerFn({ method: "POST" })
  .validator(createTeamInput)
  .handler(({ data }) =>
    playAction((db, now, viewer) => createTeamAction(db, now, viewer, data)),
  );

/** "Rename" on the team list. */
export const renameMyTeam = createServerFn({ method: "POST" })
  .validator(renameTeamInput)
  .handler(({ data }) =>
    playAction((db, now, viewer) => renameTeamAction(db, now, viewer, data)),
  );

/** "Remove": deleted before the team's first lock, retired after. */
export const removeMyTeam = createServerFn({ method: "POST" })
  .validator(removeTeamInput)
  .handler(({ data }) =>
    playAction((db, now, viewer) => removeTeamAction(db, now, viewer, data)),
  );

/** The builder for one of the viewer's teams, by slot (M6 Task 7). */
export const getBuilder = createServerFn({ method: "GET" })
  .validator(getBuilderInput)
  .handler(({ data }) =>
    playAction((db, now, viewer) => builderForSlot(db, now, viewer, data)),
  );

/** "Save team": a new lineup version; `staleBase` when another came first. */
export const saveTeam = createServerFn({ method: "POST" })
  .validator(saveTeamInput)
  .handler(({ data }) =>
    playAction((db, now, viewer) => saveTeamAction(db, now, viewer, data)),
  );

/** "Play <chip>" on the chip sheet: no undo (DM 3.9). */
export const playTeamChip = createServerFn({ method: "POST" })
  .validator(playChipInput)
  .handler(({ data }) =>
    playAction((db, now, viewer) => playChipAction(db, now, viewer, data)),
  );

/** "Play Late Call": one swap after qualifying, from the race on. */
export const playLateCall = createServerFn({ method: "POST" })
  .validator(lateCallInput)
  .handler(({ data }) =>
    playAction((db, now, viewer) => lateCallAction(db, now, viewer, data)),
  );

/**
 * `/weekend`, the hub. Public (decision 3): a logged-out visitor's answer is
 * the same for everyone and cacheable; a signed-in one's carries their
 * watched state, so it is private.
 */
export const getWeekend = createServerFn({ method: "GET" }).handler(
  async (): Promise<WeekendPage> => {
    const viewer = await getViewer(getRequest());
    setResponseHeader(
      "Cache-Control",
      viewer ? "private, no-store" : PUBLIC_CACHE,
    );
    return withRequestNow((db, now) => weekendPage(db, now, viewer));
  },
);

/**
 * `/prices`, the price board. Public (decisions 3 and 4): a logged-out
 * visitor's answer is the same for everyone and cacheable, and
 * `?show=changes` is a page of its own; a signed-in one's carries their
 * watched state and their team value, so it is private.
 */
export const getPrices = createServerFn({ method: "GET" })
  .validator(getPricesInput)
  .handler(
    async ({ data }): Promise<{ hasGame: boolean; board: PriceBoard }> => {
      const viewer = await getViewer(getRequest());
      setResponseHeader(
        "Cache-Control",
        viewer ? "private, no-store" : PUBLIC_CACHE,
      );
      return withRequestNow((db, now) => pricesPage(db, now, viewer, data));
    },
  );

/** `/prices/how`: the formula in words. The same for everyone, so public. */
export const getHowPrices = createServerFn({ method: "GET" }).handler(() => {
  setResponseHeader("Cache-Control", PUBLIC_CACHE);
  return withRequestNow((db) => howPricesPage(db));
});

/** Home for someone signed in: the weekend, the countdown and your season. */
export const getHome = createServerFn({ method: "GET" })
  .validator(getHomeInput)
  .handler(({ data }) =>
    playAction((db, now, viewer) => homeState(db, now, viewer, data)),
  );

/** `/team/$slot/points`: one team's points by session (M6 Task 11). */
export const getBreakdown = createServerFn({ method: "GET" })
  .validator(getBreakdownInput)
  .handler(({ data }) =>
    playAction((db, now, viewer) => breakdownForSlot(db, now, viewer, data)),
  );

/** `/leagues` and `/leagues/new`: the viewer's leagues and teams (M6 Task 12). */
export const getLeagues = createServerFn({ method: "GET" }).handler(() =>
  playAction((db, now, viewer) => leaguesPage(db, now, viewer)),
);

/** "Create league": the league, with the viewer's team in it. */
export const createMyLeague = createServerFn({ method: "POST" })
  .validator(createLeagueInput)
  .handler(({ data }) =>
    playAction((db, now, viewer) => createLeagueAction(db, now, viewer, data)),
  );

/** "Join league" with a code: rate-limited per user (Review Focus 5). */
export const joinMyLeague = createServerFn({ method: "POST" })
  .validator(joinLeagueInput)
  .handler(({ data }) =>
    playAction((db, now, viewer) => joinLeagueAction(db, now, viewer, data)),
  );

/** `/leagues/$slug`: one league's standings, 50 at a time (M6 Task 13). */
export const getStandings = createServerFn({ method: "GET" })
  .validator(getStandingsInput)
  .handler(({ data }) =>
    playAction((db, now, viewer) => standingsForViewer(db, now, viewer, data)),
  );

/** "Leave league". */
export const leaveMyLeague = createServerFn({ method: "POST" })
  .validator(leaveLeagueInput)
  .handler(({ data }) =>
    playAction((db, now, viewer) => leaveLeagueAction(db, now, viewer, data)),
  );
