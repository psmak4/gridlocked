/**
 * OpenF1's `team_name` -> our constructor, by the Jolpica constructor key (resolved
 * to our id through `provider_ids`). OpenF1 names teams differently from
 * Jolpica ("Red Bull Racing" / "Red Bull", "Racing Bulls" / "RB F1 Team"), so
 * the map is kept here, by hand, for the 2026 grid. A new name is an
 * `unknown_driver` review item (reason `unknown_team`), not a guess.
 */
export const OPENF1_TEAMS: Readonly<Record<string, string>> = {
  Alpine: "alpine",
  "Aston Martin": "aston_martin",
  Audi: "audi",
  Cadillac: "cadillac",
  Ferrari: "ferrari",
  "Haas F1 Team": "haas",
  McLaren: "mclaren",
  Mercedes: "mercedes",
  "Racing Bulls": "rb",
  "Red Bull Racing": "red_bull",
  Williams: "williams",
};
