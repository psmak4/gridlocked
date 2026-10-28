import { describe, expect, it } from "vitest";
import { contrastRatio, mixHex } from "./contrast";
import { palette, teamColors2026, teamTint, type ColorToken } from "./tokens";

const themes = ["light", "dark"] as const;

describe("contrastRatio", () => {
  it("is 21 for black on white and 1 for identical colors", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#777777")).toBeCloseTo(1, 5);
  });
});

describe("mixHex", () => {
  it("blends per channel and returns lowercase hex", () => {
    expect(mixHex("#ffffff", "#000000", 0.5)).toBe("#808080");
    expect(mixHex("#FF8000", "#ffffff", 0)).toBe("#ffffff");
    expect(mixHex("#ff8000", "#ffffff", 1)).toBe("#ff8000");
  });
});

describe.each(themes)("%s theme contrast", (theme) => {
  const colors = palette[theme];
  const ratio = (fg: ColorToken, bg: ColorToken) =>
    contrastRatio(colors[fg], colors[bg]);
  const surfaces = ["surface", "surface-raised"] as const;

  it.each(surfaces)("ink on %s is at least 17", (bg) => {
    expect(ratio("ink", bg)).toBeGreaterThanOrEqual(17);
  });

  it.each(["ink-muted", "heat-text", "rise", "fall"] as const)(
    "%s on surface and surface-raised is at least 4.5",
    (fg) => {
      for (const bg of surfaces) {
        expect(ratio(fg, bg)).toBeGreaterThanOrEqual(4.5);
      }
    },
  );

  it("on-heat on heat is at least 4.5", () => {
    expect(ratio("on-heat", "heat")).toBeGreaterThanOrEqual(4.5);
  });

  it("on-volt on volt is at least 4.5", () => {
    expect(ratio("on-volt", "volt")).toBeGreaterThanOrEqual(4.5);
  });

  it("line-strong on surface is at least 3", () => {
    expect(ratio("line-strong", "surface")).toBeGreaterThanOrEqual(3);
  });

  it("has team colors for all 11 teams", () => {
    expect(Object.keys(teamColors2026)).toHaveLength(11);
  });

  describe.each(Object.entries(teamColors2026))("team %s tint", (code, hex) => {
    const tint = mixHex(hex, colors.surface, teamTint[theme]);

    it.each(["ink-muted", "rise", "fall"] as const)(
      `${code}: %s on the tint is at least 4.5`,
      (fg) => {
        expect(contrastRatio(colors[fg], tint)).toBeGreaterThanOrEqual(4.5);
      },
    );
  });
});
