/**
 * Prices on the fantasy screens (M6 Task 14): the price board (going up,
 * going down, every price, your team value) and How prices work. Current
 * prices always show; a change since the event before is covered while that
 * event's race is hidden from the reader (M6 decision 4). A logged-out
 * visitor reads the same board from the CDN (decision 3), and "Show it"
 * links to `/prices?show=changes`, a page of its own.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  assetPrices,
  events,
  gameEvents,
  lineupPicks,
  poolAssets,
  teams,
} from "@/db/schema";
import type { Db } from "@/db/types";
import { priceChange } from "@/game/price-formula";
import type { RulesetParams } from "@/game/ruleset";
import type { Viewer } from "@/identity/viewer";
import { formatMoney, type MoneyUnits } from "@/lib/money";
import { revealedSessions, type Reader } from "@/spoilers/reveal";
import { paramsOf, poolRows } from "./builder";
import { currentGame } from "./current-game";
import { readerOf } from "./weekend";

export type PriceRow = {
  assetId: string;
  kind: "driver" | "constructor";
  title: string;
  /** The driver's team, or "Constructor". */
  subtitle: string;
  code: string;
  color: string;
  price: MoneyUnits;
  /** Since the event before; null while covered or with nothing before. */
  change: MoneyUnits | null;
  /** The share of the last locked event's teams that held it. */
  ownership: number | null;
  /** In the viewer's team. */
  yours: boolean;
};

export type PriceBoard = {
  /** The event these prices are for; null before any price is set. */
  event: { round: number; name: string } | null;
  /** The event whose result moved them. */
  changesFrom: {
    round: number;
    name: string;
    raceSessionId: string | null;
  } | null;
  /** That race is hidden from the reader: no change figures (decision 4). */
  changesHidden: boolean;
  /** Risers, the biggest first. */
  up: PriceRow[];
  /** Fallers, the biggest first. */
  down: PriceRow[];
  /** Every price, the dearest first. */
  all: PriceRow[];
  /** The viewer's first team: its base lineup at these prices, plus the bank. */
  teamValue: {
    teamName: string;
    now: MoneyUnits;
    change: MoneyUnits | null;
  } | null;
};

const EMPTY: PriceBoard = {
  event: null,
  changesFrom: null,
  changesHidden: false,
  up: [],
  down: [],
  all: [],
  teamValue: null,
};

/** The game's priced events, in order, with the race session of each. */
async function pricedEvents(db: Db, gameId: string) {
  const rows = await db
    .select({
      eventId: gameEvents.eventId,
      sequence: gameEvents.sequence,
      status: gameEvents.status,
      round: events.round,
      name: events.name,
      seasonId: events.seasonId,
      rulesetVersionId: gameEvents.rulesetVersionId,
      priced: sql<boolean>`exists (
        select 1 from ${assetPrices}
        inner join ${poolAssets} on ${poolAssets.id} = ${assetPrices.assetId}
        where ${assetPrices.eventId} = ${gameEvents.eventId}
          and ${poolAssets.gameId} = ${gameId}
      )`,
    })
    .from(gameEvents)
    .innerJoin(events, eq(events.id, gameEvents.eventId))
    .where(eq(gameEvents.gameId, gameId))
    .orderBy(asc(gameEvents.sequence));
  return rows.filter(
    (r) => r.sequence !== null && r.status !== "cancelled" && r.priced,
  );
}

async function raceOf(db: Db, eventId: string): Promise<string | null> {
  const { rows } = (await db.execute(
    sql`select event_race_session(${eventId}::uuid) as id`,
  )) as { rows: Array<{ id: string | null }> };
  return rows[0]?.id ?? null;
}

/**
 * The price board. `show: "changes"` reveals the change figures on this page
 * only ("Show it"); without it they follow the reader's watched state, and a
 * logged-out reader's is the 7-day window.
 */
export async function priceBoard(
  db: Db,
  now: Date,
  input: {
    gameId: string;
    reader: Reader;
    userId?: string;
    show?: "changes";
  },
): Promise<PriceBoard> {
  const priced = await pricedEvents(db, input.gameId);
  const current = priced.at(-1);
  if (!current) return EMPTY;
  const previous = priced.at(-2) ?? null;

  const raceSessionId = previous ? await raceOf(db, previous.eventId) : null;
  const changesHidden =
    previous !== null &&
    input.show !== "changes" &&
    (raceSessionId === null ||
      !(await revealedSessions(db, now, input.reader, [raceSessionId])).has(
        raceSessionId,
      ));

  // The viewer's first active team, and its base lineup for this event.
  let base: { teamName: string; picks: string[]; bank: MoneyUnits } | null =
    null;
  if (input.userId) {
    const [team] = await db
      .select({ id: teams.id, name: teams.name })
      .from(teams)
      .where(
        and(
          eq(teams.gameId, input.gameId),
          eq(teams.userId, input.userId),
          eq(teams.status, "active"),
        ),
      )
      .orderBy(asc(teams.slot))
      .limit(1);
    if (team) {
      const { rows } = (await db.execute(sql`
        select b.base_version_id, b.bank
        from team_base_state(${team.id}::uuid, ${current.eventId}::uuid) b
      `)) as { rows: Array<{ base_version_id: string | null; bank: number }> };
      const state = rows[0];
      if (state?.base_version_id) {
        const picks = await db
          .select({ assetId: lineupPicks.assetId })
          .from(lineupPicks)
          .where(eq(lineupPicks.lineupVersionId, state.base_version_id));
        base = {
          teamName: team.name,
          picks: picks.map((p) => p.assetId),
          bank: Number(state.bank),
        };
      }
    }
  }

  const pool = await poolRows(db, now, {
    gameId: input.gameId,
    eventId: current.eventId,
    seasonId: current.seasonId,
    round: current.round,
    previousEventId: previous?.eventId ?? null,
    reader: input.reader,
    owned: new Set(base?.picks ?? []),
    showChanges: !changesHidden,
  });
  const all: PriceRow[] = pool
    .map((row) => ({
      assetId: row.assetId,
      kind: row.kind,
      title: row.title,
      subtitle: row.kind === "driver" ? row.subtitle : "Constructor",
      code: row.code,
      color: row.color,
      price: row.price,
      change: changesHidden ? null : row.delta,
      ownership: row.ownership,
      yours: row.inBase,
    }))
    .sort((a, b) => b.price - a.price || a.title.localeCompare(b.title));

  const up = changesHidden
    ? []
    : all
        .filter((r) => (r.change ?? 0) > 0)
        .sort((a, b) => b.change! - a.change! || b.price - a.price);
  const down = changesHidden
    ? []
    : all
        .filter((r) => (r.change ?? 0) < 0)
        .sort((a, b) => a.change! - b.change! || b.price - a.price);

  let teamValue: PriceBoard["teamValue"] = null;
  if (base) {
    const byId = new Map(all.map((r) => [r.assetId, r]));
    const rows = base.picks.map((id) => byId.get(id));
    const value = rows.reduce((sum, r) => sum + (r?.price ?? 0), 0) + base.bank;
    const known = rows.every((r) => r?.change !== null && r !== undefined);
    teamValue = {
      teamName: base.teamName,
      now: value,
      change:
        changesHidden || !previous || !known
          ? null
          : rows.reduce((sum, r) => sum + (r!.change ?? 0), 0),
    };
  }

  return {
    event: { round: current.round, name: current.name },
    changesFrom: previous
      ? { round: previous.round, name: previous.name, raceSessionId }
      : null,
    changesHidden,
    up,
    down,
    all,
    teamValue,
  };
}

// --- How prices work ---------------------------------------------------------

export type HowStep = { title: string; text: string; value: string };

export type HowPricesWork = {
  intro: string;
  /** What the version's numbers mean, in words. */
  rules: string[];
  example: {
    label: string;
    steps: HowStep[];
    from: MoneyUnits;
    to: MoneyUnits;
    change: MoneyUnits;
  };
  outro: string;
};

/** The example's made-up driver: its price and its last three events. */
const EXAMPLE = { price: 158, points: [44, 28, 21] } as const;

const pct = (n: number) => `${Math.round(n * 100)}%`;
const tenths = (units: number) =>
  `${units >= 0 ? "+" : "−"}$${(Math.abs(units) / 10).toFixed(1)}M`;

/**
 * How prices work (wave 3), from the ruleset version in force: the formula's
 * steps in plain words, and one worked example on made-up points computed by
 * `priceChange` itself, so the page can't drift from the formula.
 */
export function howPricesWork(params: RulesetParams): HowPricesWork {
  const { formula, min, max } = params.prices;
  const { poor, good, great } = formula.thresholds;
  const result = priceChange({
    price: EXAMPLE.price,
    assetType: "driver",
    recentPoints: [...EXAMPLE.points],
    formula,
    bounds: { min, max },
  });
  const used = EXAMPLE.points.slice(-formula.window);
  const average = used.reduce((s, p) => s + p, 0) / used.length;
  const expected =
    (EXAMPLE.price / 10) * formula.pointsPerMillion.driver -
    formula.unscoredPoints.driver;
  const changes = (band: "expensive" | "cheap") =>
    formula.changes[band].map(tenths).join(", ");
  const tierWords: Record<string, string> = {
    terrible: "well below",
    poor: "a little below",
    good: "a little above",
    great: "well above",
  };

  return {
    intro:
      "Prices change once, after each race weekend is final. They stay fixed until the next lock.",
    rules: [
      `An asset's points over its last ${formula.window} race weekends are averaged.`,
      `Its price sets what it should score: ${formula.pointsPerMillion.driver} point a weekend for each $1M, less ${formula.unscoredPoints.driver} for the points this game doesn't score, like overtakes (${formula.unscoredPoints.constructor} for a constructor).`,
      `Under ${pct(poor)} of that is a bad run, ${pct(poor)} to ${pct(good)} a weak one, ${pct(good)} to ${pct(great)} a good one, and ${pct(great)} or more a great one.`,
      `From ${formatMoney(formula.bandSplit)} up, those move the price ${changes("expensive")}. Below it, ${changes("cheap")}.`,
      `Every price stays between ${formatMoney(min, { trimWhole: true })} and ${formatMoney(max, { trimWhole: true })}.`,
    ],
    example: {
      label: "Example numbers",
      steps: [
        {
          title: `Average the last ${formula.window} races`,
          text: `It scored ${used.join(", ")}.`,
          value: `${Math.round(average)} pts`,
        },
        {
          title: "Compare with what the price expects",
          text: `At ${formatMoney(EXAMPLE.price)}, a driver is expected to score about ${Math.round(expected)}.`,
          value: `${Math.round(expected)} pts`,
        },
        {
          title: "Move by how far off it was",
          text: result.tier
            ? `That's ${tierWords[result.tier]} what it should score.`
            : "With no races yet, the price stands.",
          value: tenths(result.change),
        },
        {
          title: "Keep it in bounds",
          text: `Every price stays between ${formatMoney(min, { trimWhole: true })} and ${formatMoney(max, { trimWhole: true })}.`,
          value:
            result.newPrice === EXAMPLE.price + result.change ? "OK" : "Capped",
        },
      ],
      from: EXAMPLE.price,
      to: result.newPrice,
      change: result.newPrice - EXAMPLE.price,
    },
    outro:
      "If results are corrected after prices move, your points change but prices don't.",
  };
}

// --- The pages ---------------------------------------------------------------

export const getPricesInput = z.object({
  show: z.literal("changes").optional(),
});

/** `/prices`: the board for the current game, for anyone. */
export async function pricesPage(
  db: Db,
  now: Date,
  viewer: Viewer | null,
  input: z.infer<typeof getPricesInput>,
): Promise<{ hasGame: boolean; board: PriceBoard }> {
  const game = await currentGame(db);
  if (!game) return { hasGame: false, board: EMPTY };
  return {
    hasGame: true,
    board: await priceBoard(db, now, {
      gameId: game.id,
      reader: readerOf(viewer),
      userId: viewer?.userId,
      show: input.show,
    }),
  };
}

/** `/prices/how`: the version in force for the current event. */
export async function howPricesPage(
  db: Db,
): Promise<{ hasGame: boolean; how: HowPricesWork | null }> {
  const game = await currentGame(db);
  if (!game) return { hasGame: false, how: null };
  const priced = await pricedEvents(db, game.id);
  const versionId =
    priced.at(-1)?.rulesetVersionId ??
    (
      await db
        .select({ id: gameEvents.rulesetVersionId })
        .from(gameEvents)
        .where(eq(gameEvents.gameId, game.id))
        .orderBy(asc(gameEvents.sequence))
        .limit(1)
    )[0]?.id;
  if (!versionId) return { hasGame: true, how: null };
  return { hasGame: true, how: howPricesWork(await paramsOf(db, versionId)) };
}
