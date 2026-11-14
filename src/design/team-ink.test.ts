import { describe, expect, it } from "vitest";
import { contrastRatio, mixHex } from "./contrast";
import { teamInk, teamTint } from "./team-ink";
import { palette, teamColors2026, type Theme } from "./tokens";

const teams = Object.entries(teamColors2026);
const themes: Theme[] = ["light", "dark"];

describe("teamInk", () => {
  it("covers all 11 constructors of 2026", () => {
    expect(teams).toHaveLength(11);
  });

  it.each(teams)(
    "%s: the chosen ink passes 4.5:1 on the team color",
    (_, hex) => {
      expect(contrastRatio(teamInk(hex), hex)).toBeGreaterThanOrEqual(4.5);
    },
  );

  it("picks navy on a light color and white on a dark one", () => {
    expect(teamInk(teamColors2026.MCL!)).toBe("#0b0b1e");
    expect(teamInk(teamColors2026.MER!)).toBe("#0b0b1e");
    expect(teamInk(teamColors2026.FER!)).toBe("#ffffff");
    expect(teamInk(teamColors2026.WIL!)).toBe("#ffffff");
  });

  it("prefers navy on a tie", () => {
    // Mid grey, where neither reaches 4.5:1: navy wins when it is at least as good.
    const grey = "#777777";
    const navy = contrastRatio("#0b0b1e", grey);
    const white = contrastRatio("#ffffff", grey);
    expect(teamInk(grey)).toBe(navy >= white ? "#0b0b1e" : "#ffffff");
  });
});

describe("teamTint", () => {
  it("mixes the color into surface at 12% in light and 22% in dark", () => {
    expect(teamTint("#ff8000", "light")).toBe(
      mixHex("#ff8000", palette.light.surface, 0.12),
    );
    expect(teamTint("#ff8000", "dark")).toBe(
      mixHex("#ff8000", palette.dark.surface, 0.22),
    );
  });

  describe.each(themes)("%s theme", (theme) => {
    describe.each(teams)("%s tint", (_, hex) => {
      it.each(["ink", "ink-muted", "heat-text", "rise", "fall"] as const)(
        "%s passes AA on it",
        (token) => {
          expect(
            contrastRatio(palette[theme][token], teamTint(hex, theme)),
          ).toBeGreaterThanOrEqual(4.5);
        },
      );
    });
  });
});
