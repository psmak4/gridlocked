import { describe, expect, it } from "vitest";
import { correctionSummary } from "./result-words";

describe("correctionSummary", () => {
  it("says what a correction set, in the board's words", () => {
    expect(
      correctionSummary("patch", {
        position: 2,
        classification: "disqualified",
        provider_status: "Disqualified",
      }),
    ).toBe("P2, Disqualified");
    expect(correctionSummary("suppress", {})).toBe("Removed from the results");
    expect(
      correctionSummary("insert", {
        position: 21,
        classification: "classified",
        car_number: 87,
        constructor_id: "01a1fd9f-6731-7566-90da-fde1cf905d4d",
        laps: 0,
      }),
    ).toBe("Entered by staff: P21, Finished, laps 0");
  });
});
