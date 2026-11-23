const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** At most this many reveals on one page. */
const MOST = 10;

/**
 * `all`: everything on the page, for a visitor whose device is set to show
 * results (`browserReveal`).
 */
export const SHOW_ALL = "all";

/** The ids in an old `?show=<id>,<id>` address. */
export const shownIds = (show: string | undefined): string[] =>
  (show ?? "")
    .split(",")
    .filter((id) => UUID.test(id))
    .slice(0, MOST);

export const showsAll = (show: string | undefined): boolean =>
  show === SHOW_ALL;

/** What "Show it" revealed on a page. */
export type Revealed = { ids: string[]; all: boolean };

declare module "@tanstack/react-router" {
  interface HistoryState {
    /**
     * What "Show it" revealed on this history entry (M9 Task 4): session or
     * thread ids, or `all`. Back and forward keep it; the address never
     * carries it, so a copied link reveals nothing.
     */
    shown?: string[];
  }
}

/**
 * What a history entry revealed: its state's, plus an old `?show=` link's
 * on the load that moves it into the state.
 */
export function revealOf(state: unknown, legacy?: string): Revealed {
  const raw = (state as { shown?: unknown } | null | undefined)?.shown;
  const kept = Array.isArray(raw)
    ? raw.filter((v): v is string => typeof v === "string")
    : [];
  const all = kept.includes(SHOW_ALL) || showsAll(legacy);
  const ids = [
    ...new Set([...kept.filter((id) => UUID.test(id)), ...shownIds(legacy)]),
  ].slice(0, MOST);
  return { ids: all ? [] : ids, all };
}

/** The state with `more` revealed too. */
export function withRevealed<S extends object>(
  state: S | undefined,
  more: Revealed,
): S & { shown: string[] } {
  const now = revealOf(state);
  const shown =
    now.all || more.all
      ? [SHOW_ALL]
      : [...new Set([...now.ids, ...more.ids])].slice(0, MOST);
  return { ...(state ?? ({} as S)), shown };
}

/** The state with nothing revealed. */
export function withoutRevealed<S extends object>(
  state: S | undefined,
): S & { shown: string[] } {
  return { ...(state ?? ({} as S)), shown: [] };
}
