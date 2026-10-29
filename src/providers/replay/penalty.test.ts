import { describe, expect, it } from "vitest";
import { readFixture } from "../../../tests/helpers/fixtures";
import { applyPenalty } from "./penalty";

// A time penalty applied to a recorded Jolpica race body (Task 11b).

type Row = {
  position: string;
  positionText: string;
  points: string;
  Driver: { driverId: string };
  Time?: { millis: string; time: string };
  status: string;
};
type Body = { MRData: { RaceTable: { Races: Array<{ Results: Row[] }> } } };

const recorded = () =>
  structuredClone(readFixture("jolpica/2026/r18-results.json")) as Body;
const rowsOf = (body: Body) => body.MRData.RaceTable.Races[0]!.Results;
const order = (body: Body) => rowsOf(body).map((r) => r.Driver.driverId);

describe("applyPenalty", () => {
  it("moves a driver down past everyone they are now slower than", () => {
    const before = recorded();
    const after = applyPenalty(before, "max_verstappen", 5);
    // Verstappen was 17.485 s behind and Hamilton 18.515 s: +5 s is 22.485 s.
    const ids = order(after);
    expect(ids.slice(0, 5)).toEqual([
      "antonelli",
      "leclerc",
      "hamilton",
      "max_verstappen",
      "norris",
    ]);
    // Everyone else keeps their place.
    expect(ids.slice(5)).toEqual(order(before).slice(5));
  });

  it("renumbers the positions and gives each position its own points", () => {
    const after = applyPenalty(recorded(), "max_verstappen", 5);
    const [, , third, fourth] = rowsOf(after);
    expect([third!.position, third!.positionText, third!.points]).toEqual([
      "3",
      "3",
      "15",
    ]);
    expect([fourth!.position, fourth!.positionText, fourth!.points]).toEqual([
      "4",
      "4",
      "12",
    ]);
    expect(rowsOf(after).map((r) => r.position)).toEqual(
      rowsOf(recorded()).map((r) => r.position),
    );
  });

  it("adds the seconds to the driver's time and rewrites the gap text", () => {
    const after = applyPenalty(recorded(), "max_verstappen", 5);
    const verstappen = rowsOf(after).find(
      (r) => r.Driver.driverId === "max_verstappen",
    )!;
    expect(verstappen.Time).toEqual({ millis: "5739135", time: "+22.485" });
  });

  it("does not change the body it was given", () => {
    const before = recorded();
    applyPenalty(before, "max_verstappen", 5);
    expect(before).toEqual(recorded());
  });

  it("keeps a lapped driver behind the lead lap, however big the penalty", () => {
    const after = applyPenalty(recorded(), "hulkenberg", 600);
    const ids = order(after);
    expect(ids.indexOf("hulkenberg")).toBe(10);
    expect(ids[11]).toBe("arvid_lindblad");
  });

  it("moves the driver below a lapped car only when they are on the same lap", () => {
    const after = applyPenalty(recorded(), "ocon", 20);
    // Ocon (+21.042) is lapped; Stroll is +49.418 and Alonso +1:00.668.
    expect(order(after).indexOf("ocon")).toBe(13);
    const slower = applyPenalty(recorded(), "ocon", 30);
    expect(order(slower).indexOf("ocon")).toBe(14);
  });

  it("promotes the new winner's total time and rebases every gap when the winner is penalised", () => {
    const after = applyPenalty(recorded(), "antonelli", 15);
    expect(order(after).slice(0, 3)).toEqual([
      "leclerc",
      "antonelli",
      "max_verstappen",
    ]);
    const [first, second, third] = rowsOf(after);
    expect(first!.Time).toEqual({ millis: "5729728", time: "1:35:29.728" });
    expect(second!.Time).toEqual({ millis: "5731650", time: "+1.922" });
    expect(third!.Time).toEqual({ millis: "5734135", time: "+4.407" });
  });

  it("changes nothing for a zero penalty, so the recorded gap text is what it would write", () => {
    expect(applyPenalty(recorded(), "max_verstappen", 0)).toEqual(recorded());
  });

  it("rejects a driver who is not in the body or has no time", () => {
    expect(() => applyPenalty(recorded(), "nobody", 5)).toThrow(/nobody/);
    expect(() => applyPenalty(recorded(), "bottas", 5)).toThrow(/bottas/);
  });
});
