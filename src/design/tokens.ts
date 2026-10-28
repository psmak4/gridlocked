/**
 * Gridlocked design tokens: the typed single source for the CSS variables in
 * src/styles/tokens.css. Values are copied from the design system's
 * tokens.json. `caution` is `{fall}` there, so it resolves to fall's values.
 */

export type ColorToken =
  | "surface"
  | "surface-raised"
  | "surface-sunken"
  | "line"
  | "line-strong"
  | "ink"
  | "ink-muted"
  | "heat"
  | "on-heat"
  | "heat-text"
  | "volt"
  | "on-volt"
  | "rise"
  | "fall"
  | "caution"
  | "veil"
  | "focus-ring";

export type Theme = "light" | "dark";

export const palette: Record<Theme, Record<ColorToken, string>> = {
  light: {
    surface: "#ffffff",
    "surface-raised": "#f1f1f7",
    "surface-sunken": "#e1e1ec",
    line: "#d4d4e2",
    "line-strong": "#8a8aa6",
    ink: "#0b0b1e",
    "ink-muted": "#4a4a68",
    heat: "#ff4d2e",
    "on-heat": "#0b0b1e",
    "heat-text": "#c42a10",
    volt: "#ffc400",
    "on-volt": "#0b0b1e",
    rise: "#0a64a8",
    fall: "#a8321a",
    caution: "#a8321a",
    veil: "#e6e6f0",
    "focus-ring": "#0b0b1e",
  },
  dark: {
    surface: "#0b0b1e",
    "surface-raised": "#17173a",
    "surface-sunken": "#2a2a55",
    line: "#34346a",
    "line-strong": "#7a7aae",
    ink: "#ffffff",
    "ink-muted": "#b4b4d4",
    heat: "#ff4d2e",
    "on-heat": "#0b0b1e",
    "heat-text": "#ff7a5e",
    volt: "#ffd23f",
    "on-volt": "#0b0b1e",
    rise: "#5cc8ff",
    fall: "#ff9e7a",
    caution: "#ff9e7a",
    veil: "#23234a",
    "focus-ring": "#ffd23f",
  },
};

/** Share of the team color mixed into the surface for a team tint. */
export const teamTint = { light: 0.12, dark: 0.22 } as const;

/** 2026 team colors keyed by team code (design system TeamBadge preview). */
export const teamColors2026: Record<string, string> = {
  MCL: "#ff8000",
  FER: "#e8002d",
  MER: "#27f4d2",
  RBR: "#3671c6",
  AST: "#229971",
  ALP: "#00a1e8",
  WIL: "#1868db",
  RB: "#6692ff",
  HAA: "#b6babd",
  AUD: "#bb0a30",
  CAD: "#c8102e",
};
