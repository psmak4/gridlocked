/**
 * The results board's words (M8 Task 7): what a correction can change and
 * the status words a corrected classification shows. No imports, so the
 * screen can load it.
 */

/** What "Add a correction" can change, in the board's order. */
export const CORRECTION_FIELDS = [
  "position",
  "classification",
  "grid",
  "fastest_lap",
  "remove",
] as const;
export type CorrectionField = (typeof CORRECTION_FIELDS)[number];

export const CORRECTION_WORDS: Record<CorrectionField, string> = {
  position: "Finishing position",
  classification: "Status",
  grid: "Starting grid",
  fastest_lap: "Fastest lap",
  remove: "Remove from the results",
};

/** A classification as the STATUS column shows it once corrected. */
export const CLASSIFICATION_WORDS = {
  classified: "Finished",
  not_classified: "Not classified",
  disqualified: "Disqualified",
  did_not_start: "Did not start",
  did_not_qualify: "Did not qualify",
  excluded: "Excluded",
} as const;
export type ClassificationWord = keyof typeof CLASSIFICATION_WORDS;

/** A correction as "What changed" lists it: "P2, Disqualified". */
export function correctionSummary(
  kind: "patch" | "insert" | "suppress",
  fields: Record<string, unknown>,
): string {
  if (kind === "suppress") return "Removed from the results";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    // Bookkeeping an insert carries, not something a person corrected.
    if (
      key === "provider_status" ||
      key === "provider_position_text" ||
      key === "constructor_id" ||
      key === "car_number"
    ) {
      continue;
    }
    if (key === "position")
      parts.push(value === null ? "no place" : `P${value}`);
    else if (key === "grid") parts.push(`grid ${value}`);
    else if (key === "fastest_lap_rank")
      parts.push(`fastest lap rank ${value}`);
    else if (key === "classification") {
      parts.push(
        CLASSIFICATION_WORDS[value as ClassificationWord] ?? String(value),
      );
    } else parts.push(`${key.replaceAll("_", " ")} ${String(value)}`);
  }
  const what = parts.join(", ");
  return kind === "insert" ? `Entered by staff: ${what}` : what;
}

/** A session's result status, as its badge says it. */
export const RESULT_STATUS_WORDS = {
  awaiting: "Awaiting",
  provisional: "Provisional",
  under_review: "Under review",
  final: "Final",
} as const;
