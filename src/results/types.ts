import type { SESSION_KINDS } from "@/db/schema";

export type SessionKind = (typeof SESSION_KINDS)[number];

export type Classification =
  | "classified"
  | "not_classified"
  | "disqualified"
  | "did_not_start"
  | "did_not_qualify"
  | "excluded";

/**
 * The provider-neutral facts of one driver's result in one session (DM 2.4),
 * minus who the driver and car are. Field names follow the `results` columns.
 */
export interface ResultFacts {
  carNumber: number;
  position: number | null;
  classification: Classification;
  providerStatus: string;
  providerPositionText: string;
  grid: number | null;
  pitLaneStart: boolean;
  laps: number | null;
  timeMs: number | null;
  fastestLapRank: number | null;
  fastestLapMs: number | null;
  q1Ms: number | null;
  q2Ms: number | null;
  q3Ms: number | null;
  /** One decimal place (`"25.0"`), as the `numeric(4,1)` column returns it. */
  officialPoints: string | null;
}

/** A result with our own driver and constructor ids, ready to store. */
export interface ResultRow extends ResultFacts {
  driverId: string;
  constructorId: string;
}

/**
 * What parsing a provider response gives the normalizer. A failure says which
 * review item to open: a `positionText` we have no mapping for is
 * `unknown_classification`; anything else that is not the shape we expect is
 * `validation_failed`.
 */
export type ParsedResults =
  | { ok: true; rows: ResultRow[] }
  | {
      ok: false;
      problem: string;
      code: "unknown_classification" | "validation_failed";
    };
