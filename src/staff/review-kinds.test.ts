import { describe, expect, it } from "vitest";
import { REVIEW_KINDS } from "./review-kinds";

// Every kind of review item the app opens has its words and actions (M8
// Task 10). `openReviewItem` takes only these kinds, so a new kind without
// an entry doesn't compile.
describe("REVIEW_KINDS", () => {
  const view = {
    item: {
      id: "i1",
      kind: "x",
      severity: "warning" as const,
      eventId: null,
      sessionId: null,
      driverId: null,
      details: {},
    },
    names: {},
    event: null,
    session: null,
  };

  it('every ReviewKind has a title, a summary and at least one action, the last always "Dismiss"', () => {
    const kinds = Object.entries(REVIEW_KINDS);
    expect(kinds.length).toBeGreaterThanOrEqual(27);
    for (const [kind, spec] of kinds) {
      expect(spec.title(view), kind).toMatch(/\S/);
      expect(spec.summary(view), kind).toMatch(/\S/);
      expect(spec.actions.length, kind).toBeGreaterThan(0);
      expect(spec.actions.at(-1), kind).toMatchObject({
        id: "dismiss",
        label: "Dismiss",
      });
      const ids = spec.actions.map((a) => a.id);
      expect(new Set(ids).size, kind).toBe(ids.length);
      // A "Go to …" action links somewhere; every other one changes something.
      for (const action of spec.actions.slice(0, -1)) {
        expect(
          Boolean(action.run) !== Boolean(action.href),
          `${kind} ${action.id}`,
        ).toBe(true);
      }
    }
  });

  it("the board's five use its actions", () => {
    const ids = (kind: keyof typeof REVIEW_KINDS) =>
      REVIEW_KINDS[kind].actions.map((a) => a.label);
    expect(ids("team_change")).toContain("Update seats from this event on");
    expect(ids("missing_driver")).toContain("Mark unavailable");
    expect(ids("event_missing_from_provider")).toContain("Mark cancelled");
    expect(ids("uncertain_event_match")).toContain("Go to Calendar");
    expect(ids("provider_after_manual")).toContain("Go to session results");
  });
});
