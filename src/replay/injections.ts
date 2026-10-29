/**
 * Things the replay does to the recorded world (HLD §12, scripted scenarios).
 * Times are ISO 8601 instants with an offset.
 *
 * - `penalty`: from `at` on, the race answers as if the stewards had added
 *   `seconds` to `driver`'s time (a Jolpica driver id) and the classification
 *   had been redone.
 * - `outage`: every provider request in [`at`, `until`) is refused with a 503.
 */
export type Injection =
  | { at: string; kind: "penalty"; driver: string; seconds: number }
  | { at: string; kind: "outage"; until: string };
