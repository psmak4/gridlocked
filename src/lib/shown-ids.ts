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

/** `show` with one more id. */
export const withShown = (show: string | undefined, id: string): string =>
  [...new Set([...shownIds(show), id])].join(",");
