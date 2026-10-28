// Our own shapes for a season's drivers and constructors. Adapters parse a
// provider's response into these; `key` is the provider's opaque id, stored in
// `provider_ids` (DM 1.11).

export interface RosterDriver {
  key: string;
  givenName: string;
  familyName: string;
  code: string | null;
  permanentNumber: number | null;
  /** Empty when the provider does not say (reserve drivers). */
  nationality: string;
  /** `YYYY-MM-DD`. */
  dateOfBirth: string | null;
}

export interface RosterConstructor {
  key: string;
  name: string;
  nationality: string;
  /** Our team code (`RBR`), used to find the season's color; null if unknown. */
  teamCode: string | null;
}

export interface RosterSource<T> {
  items: T[];
  /** The raw snapshot the list was parsed from, kept in review details. */
  snapshotId: string;
  /** Which provider's keys the items carry. Default `jolpica`. */
  provider?: string;
}
