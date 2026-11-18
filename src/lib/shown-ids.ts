const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The ids in a `?show=<id>,<id>` address: what "Show it" revealed on this
 * page. It lasts until the page is left and is never stored.
 */
export const shownIds = (show: string | undefined): string[] =>
  (show ?? "")
    .split(",")
    .filter((id) => UUID.test(id))
    .slice(0, 10);

/**
 * `?show=all`: everything on the page, for a visitor whose device is set to
 * show results (`browserReveal`). A page of its own, so the CDN keeps the
 * safe default apart from it.
 */
export const SHOW_ALL = "all";

export const showsAll = (show: string | undefined): boolean =>
  show === SHOW_ALL;

/** `show` with one more id. */
export const withShown = (show: string | undefined, id: string): string =>
  showsAll(show) ? SHOW_ALL : [...new Set([...shownIds(show), id])].join(",");
