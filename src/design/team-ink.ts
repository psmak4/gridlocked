import { contrastRatio, mixHex } from "./contrast";
import { palette, teamTint as tintShare, type Theme } from "./tokens";

const NAVY = "#0b0b1e";
const WHITE = "#ffffff";

/**
 * The text color for a solid block of a team's color: navy (`on-heat`) or
 * white, whichever passes 4.5:1 on it. Only one of them can pass on any
 * color; where neither does, the stronger wins, and navy wins a tie.
 */
export function teamInk(color: string): typeof NAVY | typeof WHITE {
  return contrastRatio(NAVY, color) >= contrastRatio(WHITE, color)
    ? NAVY
    : WHITE;
}

/**
 * A team's row tint: its color mixed into `surface`, at 12% in light and 22%
 * in dark. Components draw it in CSS with `--team-tint`, which follows the
 * theme; this is the same color as a hex, for contrast checks.
 */
export function teamTint(color: string, theme: Theme): string {
  return mixHex(color, palette[theme].surface, tintShare[theme]);
}

/** The CSS for a team tint, following the theme through `--team-tint`. */
export function teamTintCss(color: string): string {
  return `color-mix(in srgb, ${color} var(--team-tint), var(--surface))`;
}
