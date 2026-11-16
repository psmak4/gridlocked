import type { GameErrorCode } from "@/game/errors";
import type { LeagueRow } from "@/play/leagues";
import { ordinal } from "./weekend-words";

/** A league refusal, in plain words (wave 3's Join and Create). */
export function leagueRefusalWords(
  code: GameErrorCode | "server_error" | null,
): string {
  switch (code) {
    case "rate_limited":
      return "Too many tries. Wait a few minutes.";
    case "league_not_found":
      return "No league has that code.";
    case "already_member":
      return "That team is in this league already.";
    case "league_full":
      return "That league is full.";
    case "league_cap":
      return "That team is in 50 leagues, the most it can join.";
    case "team_retired":
      return "A retired team can't join a league.";
    case "team_not_owned":
      return "That team isn't yours.";
    case "bad_name":
      return "A league name is 1 to 40 characters.";
    case "bad_range":
      return "Pick a last round that's the same as the first or after it.";
    case "game_not_open":
      return "The game isn't open yet.";
    default:
      return "That didn't work. Try again.";
  }
}

const KIND_WORDS: Record<LeagueRow["kind"], string> = {
  global: "Global",
  public: "Public",
  private: "Private",
  auto_constructor: "Favorite team",
  auto_driver: "Favorite driver",
  auto_country: "Your country",
};

/** "12 teams". */
const teamsWord = (n: number) =>
  `${n.toLocaleString("en-GB")} ${n === 1 ? "team" : "teams"}`;

/**
 * A league row's subtitle: "Private · 12 teams", "Mini-league · rounds 6–13",
 * with the team's name when the viewer has more than one.
 */
export function leagueSubtitle(row: LeagueRow, manyTeams: boolean): string {
  const parts = [
    row.rounds
      ? `Mini-league · ${
          row.rounds.to === null
            ? `from round ${row.rounds.from}`
            : row.rounds.to === row.rounds.from
              ? `round ${row.rounds.from}`
              : `rounds ${row.rounds.from}–${row.rounds.to}`
        }`
      : KIND_WORDS[row.kind],
    teamsWord(row.members),
  ];
  if (manyTeams) parts.push(row.teamName);
  return parts.join(" · ");
}

/** The row's figure: "2nd", "Hidden" while the table is covered, else "–". */
export function rankFigure(row: LeagueRow): string {
  if (row.hidden) return "Hidden";
  return row.rank === null ? "–" : ordinal(row.rank);
}

/** The row's second figure: "▲ up 1", "▼ down 3", "No change", or nothing. */
export function moveWords(move: number | null): string | undefined {
  if (move === null) return undefined;
  if (move > 0) return `▲ up ${move}`;
  if (move < 0) return `▼ down ${-move}`;
  return "No change";
}
