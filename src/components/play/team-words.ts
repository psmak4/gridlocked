/**
 * The team builder's words (wave 2's boards): refusals, the over-the-cap and
 * penalty sentences, the transfer note and the lock countdown. Pure, so each
 * is tested on its own.
 */
import type { GameErrorCode } from "@/game/errors";
import { formatMoney, type MoneyUnits } from "@/lib/money";
import type { PoolRow } from "@/play/builder";
import type { TeamPreview, TeamProblem } from "@/play/preview";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const two = (n: number) => String(n).padStart(2, "0");

/**
 * The lock countdown's value: "1D 04:12" (days, hours, minutes) for a day or
 * more, "04:12" (hours, minutes) under a day, "09:59" (minutes, seconds) in
 * the last 10 minutes, and "LOCKED" from the lock on.
 */
export function lockCountdown(ms: number): string {
  if (ms <= 0) return "LOCKED";
  if (ms < 10 * MINUTE_MS) {
    const seconds = Math.ceil(ms / 1000);
    return `${two(Math.floor(seconds / 60))}:${two(seconds % 60)}`;
  }
  const minutes = Math.floor(ms / MINUTE_MS);
  const hhmm = `${two(Math.floor(minutes / 60) % 24)}:${two(minutes % 60)}`;
  return ms >= DAY_MS ? `${Math.floor(ms / DAY_MS)}D ${hhmm}` : hhmm;
}

/** How long until the countdown next changes: a minute, or a second near the end. */
export function countdownTick(ms: number): number {
  if (ms <= 0) return MINUTE_MS;
  if (ms <= 10 * MINUTE_MS) return ms % 1000 || 1000;
  return ms % MINUTE_MS || MINUTE_MS;
}

/** "14:00": an instant in the viewer's time zone, falling back to UTC. */
export function clockTime(iso: string, timeZone: string): string {
  const options = {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  } as const;
  try {
    return new Intl.DateTimeFormat("en-GB", { ...options, timeZone }).format(
      new Date(iso),
    );
  } catch {
    return new Intl.DateTimeFormat("en-GB", {
      ...options,
      timeZone: "UTC",
    }).format(new Date(iso));
  }
}

/** A failed save, in plain words. `server_error` is anything that isn't a refusal. */
export function teamWords(
  error: GameErrorCode | "server_error",
  ctx: { lockAt: string | null; timeZone: string },
): string {
  switch (error) {
    case "window_closed":
      return ctx.lockAt
        ? `Your team locked at ${clockTime(ctx.lockAt, ctx.timeZone)}.`
        : "Your team is locked for now.";
    case "over_budget":
      return "Your team is over the cap at the latest prices. Swap a driver to save.";
    case "asset_unavailable":
      return "One of your picks can't be picked any more. Swap it to save.";
    case "composition":
      return "Your team isn't complete. Check your drivers, constructors and Boost.";
    case "team_retired":
      return "This team is retired, so it can't be changed.";
    case "team_not_owned":
      return "That team isn't yours.";
    case "game_not_open":
      return "The game isn't open yet.";
    default:
      return "Your team wasn't saved. Try again.";
  }
}

const money = (units: MoneyUnits) => formatMoney(units);

/** "You're $1.4M over the cap. Swap one driver to save." */
export function overCapWords(overBy: MoneyUnits): string {
  return `You're ${money(overBy)} over the cap. Swap one driver to save.`;
}

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth"];
const ordinal = (n: number) => ORDINALS[n - 1] ?? `${n}th`;

/**
 * The penalty line, when changes go past the free ones: "3 changes this week.
 * 2 are free, so the third costs 10 points." Null when nothing is extra.
 */
export function penaltyWords(preview: TeamPreview): string | null {
  const { transfers, free, extra, penalty } = preview;
  if (free === null || extra === 0) return null;
  const points = `${Math.abs(penalty)} points`;
  const changes = `${transfers} ${transfers === 1 ? "change" : "changes"} this week.`;
  if (free === 0) {
    return extra === 1
      ? `${changes} None are free, so it costs ${points}.`
      : `${changes} None are free, so they cost ${points}.`;
  }
  const freePart = free === 1 ? "1 is free" : `${free} are free`;
  return extra === 1
    ? `${changes} ${freePart}, so the ${ordinal(free + 1)} costs ${points}.`
    : `${changes} ${freePart}, so the other ${extra} cost ${points}.`;
}

/** The note beside DRIVERS: "1 of 2 free transfers used", or what the extra costs. */
export function transferNote(preview: TeamPreview): string {
  const { transfers, free, extra, penalty } = preview;
  if (free === null) return "Unlimited free transfers";
  if (extra > 0) {
    return `${transfers} changes · ${extra} ${extra === 1 ? "costs" : "cost"} ${Math.abs(penalty)} pts`;
  }
  return `${transfers} of ${free} free ${free === 1 ? "transfer" : "transfers"} used`;
}

/** The countdown's Transfers stat: "1/2", or "Free" when unlimited. */
export function transferStat(preview: TeamPreview): string {
  return preview.free === null
    ? "Free"
    : `${preview.transfers}/${preview.free}`;
}

const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

/**
 * The first thing stopping a save, in one sentence, or null. Over the cap
 * has its own sentence (`overCapWords`).
 */
export function problemWords(
  problems: TeamProblem[],
  counts: {
    drivers: number;
    constructors: number;
    squad: { drivers: number; constructors: number };
  },
): string | null {
  const needDrivers = counts.squad.drivers - counts.drivers;
  const needConstructors = counts.squad.constructors - counts.constructors;
  for (const problem of problems) {
    switch (problem) {
      case "drivers":
      case "constructors": {
        // "more" once anything is picked: "Pick 2 more drivers to save."
        const more = counts.drivers + counts.constructors > 0 ? "more " : "";
        const parts = [
          needDrivers > 0 ? plural(needDrivers, `${more}driver`) : null,
          needConstructors > 0
            ? plural(needConstructors, `${more}constructor`)
            : null,
        ].filter((part): part is string => part !== null);
        if (parts.length === 0) {
          return `A team has ${counts.squad.drivers} drivers and ${counts.squad.constructors} constructors.`;
        }
        return `Pick ${parts.join(" and ")} to save.`;
      }
      case "boost":
        return "Choose one driver for the 2× Boost.";
      case "x3_target":
        return "Keep your Overdrive driver, without the 2× Boost.";
      case "unavailable":
        return "Swap out the pick that can't be picked any more.";
      case "over_budget":
        break;
    }
  }
  return null;
}

/**
 * The line above the list when a pick won't race: "Hadjar is out this race."
 * Out comes before doubtful; a withdrawn pick the team owns counts as out.
 */
export function inactiveWords(picked: PoolRow[]): string | null {
  const names = (rows: PoolRow[]) => {
    const all = rows.map((row) => row.title);
    return all.length <= 1
      ? (all[0] ?? "")
      : `${all.slice(0, -1).join(", ")} and ${all.at(-1)}`;
  };
  const out = picked.filter(
    (row) => row.availability === "out" || row.availability === "withdrawn",
  );
  if (out.length > 0) {
    return `${names(out)} ${out.length === 1 ? "is" : "are"} out this race.`;
  }
  const doubtful = picked.filter((row) => row.availability === "doubtful");
  if (doubtful.length > 0) {
    return `${names(doubtful)} ${doubtful.length === 1 ? "is" : "are"} doubtful for this race.`;
  }
  return null;
}
