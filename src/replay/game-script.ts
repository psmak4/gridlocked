/**
 * The 2026 season replay's script (M3 Task 9): the moves a set of scripted
 * teams and the staff make over the season, each at a simulated instant, for
 * the clock loop to run as its `actions`. Times are ISO 8601 instants on a
 * whole minute, since the clock loop visits whole minutes and an action runs
 * with the clock at its own `at`.
 *
 * Assets are named by script keys, which this file never reads: the caller
 * resolves them (`GameScriptRun.assetId`; the 2026 script's keys are Jolpica
 * ids, resolved in the test helpers). Rounds are calendar rounds.
 *
 * The players' moves, each for a team by its label (the team's name):
 * - `create`: a team for a new user;
 * - `save`: a lineup, `picks` with the 2x Boost on `boost`, from a `device`
 *   (`main` by default). A device edits the version it saved last, or else the
 *   team's latest, so two devices give a stale base (`staleBase`, checked when
 *   given);
 * - `chip`: a chip played for the open event (`target` for the x3 Boost);
 * - `finalFix`: Late Call, swapping `out` for `in` in the latest locked lineup.
 *
 * `expectRefused` wraps one of those and names the `GameErrorCode` it must be
 * refused with. A wrapped move that goes through, or fails any other way,
 * fails the replay, as does any other move that fails.
 *
 * What the staff and the pipeline do:
 * - `adminPrice`: an admin price for an event that hasn't opened (its prices
 *   are fixed once it has);
 * - `withdraw`: an asset withdrawn from a round on;
 * - `resultsIn`: a session's results arrive (its result state goes
 *   `provisional`), standing in for the pipeline's poll. It writes no result
 *   rows, so a later `completeEvent` scores that session from nothing and the
 *   formula prices the next event from those zeros. This rules replay accepts
 *   that, and only this replay does it;
 * - `cancelEvent`: the calendar marks the round cancelled, and the game is
 *   planned again, as the calendar sync does;
 * - `completeEvent`: the round's event is `completed`, standing in for the
 *   finalizer (M2's replay proved it), since the import plans no pipeline
 *   jobs. Then it runs `finalizeGameEvent` directly, which makes the game event
 *   `final` and queues the next open.
 */
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  events,
  lineupVersions,
  SESSION_KINDS,
  sessionResultState,
  sessions,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { playChip, saveFinalFix } from "@/game/chips";
import { GameError, type GameErrorCode } from "@/game/errors";
import { planGameEvents } from "@/game/games";
import { planGameJobs } from "@/game/jobs";
import { finalizeGameEvent } from "@/game/score-jobs";
import { saveLineup } from "@/game/lineups";
import { withdrawPoolAsset } from "@/game/pool";
import { publishPrices } from "@/game/prices";
import { createTeam } from "@/game/teams";
import { newId } from "@/lib/ids";
import type { StaffActor } from "@/staff/roster";

const GAME_ERROR_CODES = [
  "game_not_open",
  "no_free_slot",
  "bad_name",
  "window_closed",
  "composition",
  "asset_unavailable",
  "over_budget",
  "chip_unavailable",
  "chip_window_closed",
] as const satisfies readonly GameErrorCode[];

const MINUTE_MS = 60_000;
/** Who the script's staff actions are audited as. */
const ACTOR: StaffActor = { kind: "admin", label: "replay" };

const instant = z.iso
  .datetime({ offset: true })
  .refine((at) => Date.parse(at) % MINUTE_MS === 0, {
    message: "a script time is a whole minute",
  });
const label = z.string().min(1);
const key = z.string().min(1);
const round = z.number().int().positive();
const timed = { at: instant, note: z.string().optional() };

const create = z.strictObject({ kind: z.literal("create"), team: label });
const save = z.strictObject({
  kind: z.literal("save"),
  team: label,
  picks: z.array(key),
  boost: key,
  device: z.string().min(1).optional(),
  staleBase: z.boolean().optional(),
});
const chip = z.strictObject({
  kind: z.literal("chip"),
  team: label,
  chip: z.string().min(1),
  target: key.optional(),
});
const finalFix = z.strictObject({
  kind: z.literal("finalFix"),
  team: label,
  out: key,
  in: key,
});
const playerAction = z.discriminatedUnion("kind", [
  create,
  save,
  chip,
  finalFix,
]);

export const gameActionSchema = z.discriminatedUnion("kind", [
  create.extend(timed),
  save.extend(timed),
  chip.extend(timed),
  finalFix.extend(timed),
  z.strictObject({
    ...timed,
    kind: z.literal("expectRefused"),
    code: z.enum(GAME_ERROR_CODES),
    action: playerAction,
  }),
  z.strictObject({
    ...timed,
    kind: z.literal("adminPrice"),
    round,
    prices: z.record(key, z.number().int()),
    reason: z.string().min(1),
  }),
  z.strictObject({
    ...timed,
    kind: z.literal("withdraw"),
    asset: key,
    fromRound: round,
    reason: z.string().min(1),
  }),
  z.strictObject({
    ...timed,
    kind: z.literal("resultsIn"),
    round,
    session: z.enum(SESSION_KINDS),
  }),
  z.strictObject({ ...timed, kind: z.literal("cancelEvent"), round }),
  z.strictObject({ ...timed, kind: z.literal("completeEvent"), round }),
]);

export const gameScriptSchema = z.strictObject({
  /** What the script is for, for the reader. */
  note: z.string(),
  actions: z.array(gameActionSchema),
});

export type GameAction = z.infer<typeof gameActionSchema>;
export type GameScript = z.infer<typeof gameScriptSchema>;
type PlayerAction = z.infer<typeof playerAction>;
type OtherAction = Exclude<GameAction, { kind: PlayerAction["kind"] }>;

const isPlayerAction = (
  action: GameAction,
): action is GameAction & PlayerAction =>
  playerAction.options.some(
    (option) => option.shape.kind.value === action.kind,
  );

/** What a replay of a script knows, and what its moves have left. */
export interface GameScriptRun {
  gameId: string;
  /** The pool asset a script key names. */
  assetId: (key: string) => Promise<string>;
  /** The event of a calendar round. */
  eventOf: (round: number) => string;
  /** Team ids by label, filled by `create`. */
  teams: Map<string, string>;
  /** The version each device of a team has open, by `<team>/<device>`. */
  devices: Map<string, string>;
  /** `expectRefused` moves refused as expected. */
  refused: number;
}

export function newGameScriptRun(input: {
  gameId: string;
  assetId: (key: string) => Promise<string>;
  eventOf: (round: number) => string;
}): GameScriptRun {
  return { ...input, teams: new Map(), devices: new Map(), refused: 0 };
}

function teamOf(run: GameScriptRun, team: string): string {
  const id = run.teams.get(team);
  if (!id) throw new Error(`no team "${team}" (create it first)`);
  return id;
}

async function applyPlayerAction(
  db: Db,
  now: Date,
  run: GameScriptRun,
  action: PlayerAction,
): Promise<void> {
  switch (action.kind) {
    case "create": {
      if (run.teams.has(action.team)) {
        throw new Error(`team "${action.team}" exists already`);
      }
      const id = await createTeam(db, now, {
        gameId: run.gameId,
        userId: newId(),
        name: action.team,
      });
      run.teams.set(action.team, id);
      return;
    }
    case "save": {
      const teamId = teamOf(run, action.team);
      const device = `${action.team}/${action.device ?? "main"}`;
      if (!action.picks.includes(action.boost)) {
        throw new Error(`the Boost ${action.boost} is not one of the picks`);
      }
      const picks = await Promise.all(
        action.picks.map(async (k) => ({
          assetId: await run.assetId(k),
          isBoost: k === action.boost,
        })),
      );
      // A device edits what it saved last; one that hasn't saved yet opens
      // the team's latest version.
      let basedOnVersionId = run.devices.get(device) ?? null;
      if (basedOnVersionId === null) {
        const [latest] = await db
          .select({ id: lineupVersions.id })
          .from(lineupVersions)
          .where(eq(lineupVersions.teamId, teamId))
          .orderBy(desc(lineupVersions.savedAt), desc(lineupVersions.id))
          .limit(1);
        basedOnVersionId = latest?.id ?? null;
      }
      const saved = await saveLineup(db, now, {
        teamId,
        picks,
        basedOnVersionId,
      });
      run.devices.set(device, saved.versionId);
      if (
        action.staleBase !== undefined &&
        saved.staleBase !== action.staleBase
      ) {
        throw new Error(
          `the save's staleBase is ${saved.staleBase}, expected ${action.staleBase}`,
        );
      }
      return;
    }
    case "chip": {
      await playChip(db, now, {
        teamId: teamOf(run, action.team),
        chipCode: action.chip,
        targetAssetId:
          action.target === undefined
            ? undefined
            : await run.assetId(action.target),
      });
      return;
    }
    case "finalFix": {
      await saveFinalFix(db, now, {
        teamId: teamOf(run, action.team),
        outAssetId: await run.assetId(action.out),
        inAssetId: await run.assetId(action.in),
      });
      return;
    }
  }
}

async function applyOther(
  db: Db,
  now: Date,
  run: GameScriptRun,
  action: OtherAction,
): Promise<void> {
  switch (action.kind) {
    case "expectRefused": {
      const outcome = await applyPlayerAction(db, now, run, action.action).then(
        () => undefined,
        (error: unknown) => error,
      );
      if (outcome === undefined) {
        throw new Error(
          `expected it refused with ${action.code}, but it went through`,
        );
      }
      if (!(outcome instanceof GameError) || outcome.code !== action.code) {
        const got =
          outcome instanceof GameError
            ? `GameError ${outcome.code}`
            : String(outcome);
        throw new Error(`expected it refused with ${action.code}, got ${got}`, {
          cause: outcome,
        });
      }
      run.refused += 1;
      return;
    }
    case "adminPrice": {
      await publishPrices(db, now, {
        gameId: run.gameId,
        eventId: run.eventOf(action.round),
        prices: await Promise.all(
          Object.entries(action.prices).map(async ([k, price]) => ({
            assetId: await run.assetId(k),
            price,
          })),
        ),
        source: "admin",
        reason: action.reason,
        actor: ACTOR,
      });
      return;
    }
    case "withdraw": {
      await withdrawPoolAsset(db, now, {
        assetId: await run.assetId(action.asset),
        fromEventId: run.eventOf(action.fromRound),
        reason: action.reason,
        actor: ACTOR,
      });
      return;
    }
    case "resultsIn": {
      const eventId = run.eventOf(action.round);
      const [session] = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(
          and(eq(sessions.eventId, eventId), eq(sessions.kind, action.session)),
        );
      if (!session) {
        throw new Error(`round ${action.round} has no ${action.session}`);
      }
      await db
        .insert(sessionResultState)
        .values({ sessionId: session.id, status: "provisional" })
        .onConflictDoUpdate({
          target: sessionResultState.sessionId,
          set: { status: "provisional" },
        });
      return;
    }
    case "cancelEvent": {
      await db
        .update(events)
        .set({ status: "cancelled", updatedAt: now })
        .where(eq(events.id, run.eventOf(action.round)));
      // What the calendar sync does next, for the game.
      await planGameEvents(db, now, run.gameId);
      await planGameJobs(db, now, run.gameId);
      return;
    }
    case "completeEvent": {
      await db
        .update(events)
        .set({ status: "completed", updatedAt: now })
        .where(eq(events.id, run.eventOf(action.round)));
      await finalizeGameEvent(db, now, {
        gameId: run.gameId,
        eventId: run.eventOf(action.round),
      });
      return;
    }
  }
}

/**
 * Does one scripted move at `now` (its `at`, with the simulated clock there).
 * A move that fails, or an `expectRefused` that isn't refused as it says,
 * throws, naming the move.
 */
export async function applyGameAction(
  db: Db,
  now: Date,
  run: GameScriptRun,
  action: GameAction,
): Promise<void> {
  try {
    if (isPlayerAction(action)) {
      await applyPlayerAction(db, now, run, action);
    } else {
      await applyOther(db, now, run, action as OtherAction);
    }
  } catch (error) {
    const move = action.kind === "expectRefused" ? action.action : action;
    const who = "team" in move ? ` "${move.team}"` : "";
    const inner = action.kind === "expectRefused" ? ` ${move.kind}` : "";
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `replay: ${action.at} ${action.kind}${inner}${who}: ${message}`,
      { cause: error },
    );
  }
}
