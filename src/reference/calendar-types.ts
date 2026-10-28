import type { EVENT_FORMATS, SESSION_KINDS } from "@/db/schema";

export type SessionKind = (typeof SESSION_KINDS)[number];
export type EventFormat = (typeof EVENT_FORMATS)[number];

// Our own shape for a season calendar. Adapters (src/providers/**) parse a
// provider's response into this; src/reference never sees a provider's shape.
// The `key` fields are opaque strings the adapter chose. They are stored in
// `provider_ids` and handed back unchanged, so the sync can re-match an event
// after the provider renumbers it (DM 1.11).

export interface CalendarCircuit {
  key: string;
  name: string;
  locality: string;
  country: string;
  /** Decimal strings, as numeric(9,6) columns take them. */
  latitude: string;
  longitude: string;
  /** IANA zone, or null when the adapter does not know it (an admin sets it). */
  timezone: string | null;
}

export interface CalendarSession {
  kind: SessionKind;
  start: Date;
  /** False when the provider gave only a date. */
  confirmed: boolean;
}

export interface CalendarEvent {
  /** The provider's key for this event. It changes when rounds are renumbered. */
  key: string;
  round: number;
  name: string;
  /** `YYYY-MM-DD`, the day of the race. */
  raceDate: string;
  format: EventFormat;
  circuit: CalendarCircuit;
  sessions: CalendarSession[];
}

export interface SyncReport {
  created: number;
  updated: number;
  unchanged: number;
  /** Review items newly opened by this run. */
  reviewItems: number;
  /** `created + updated`. */
  changed: number;
}

export interface CalendarSource {
  events: CalendarEvent[];
  /** The raw snapshot the events were parsed from, kept in review details. */
  snapshotId: string;
  /** Which provider's keys the events carry. Default `jolpica`. */
  provider?: string;
}
