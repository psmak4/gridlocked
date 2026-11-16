import { describe, expect, it } from "vitest";
import type { LeagueRow } from "@/play/leagues";
import {
  leagueRefusalWords,
  leagueSubtitle,
  moveWords,
  rankFigure,
} from "./league-words";

const row = (over: Partial<LeagueRow> = {}): LeagueRow => ({
  leagueId: "l",
  slug: "monday-night-league-abc123",
  name: "Monday Night League",
  kind: "private",
  teamId: "t",
  teamName: "Late Brakers",
  rank: 2,
  move: 1,
  hidden: false,
  members: 12,
  rounds: null,
  joinCode: "K7Q2M9XDAB",
  mine: false,
  ...over,
});

describe("league words", () => {
  it("subtitles by kind, members and range", () => {
    expect(leagueSubtitle(row(), false)).toBe("Private · 12 teams");
    expect(leagueSubtitle(row({ kind: "global", members: 1048 }), false)).toBe(
      "Global · 1,048 teams",
    );
    expect(leagueSubtitle(row({ kind: "auto_driver", members: 1 }), true)).toBe(
      "Favorite driver · 1 team · Late Brakers",
    );
    expect(leagueSubtitle(row({ rounds: { from: 6, to: 13 } }), false)).toBe(
      "Mini-league · rounds 6–13 · 12 teams",
    );
    expect(leagueSubtitle(row({ rounds: { from: 6, to: null } }), false)).toBe(
      "Mini-league · from round 6 · 12 teams",
    );
  });

  it("the rank, covered while hidden", () => {
    expect(rankFigure(row())).toBe("2nd");
    expect(rankFigure(row({ rank: null }))).toBe("–");
    expect(rankFigure(row({ rank: null, hidden: true }))).toBe("Hidden");
  });

  it("the move in words", () => {
    expect(moveWords(14)).toBe("▲ up 14");
    expect(moveWords(-3)).toBe("▼ down 3");
    expect(moveWords(0)).toBe("No change");
    expect(moveWords(null)).toBeUndefined();
  });

  it("refusals in words", () => {
    expect(leagueRefusalWords("rate_limited")).toBe(
      "Too many tries. Wait a few minutes.",
    );
    expect(leagueRefusalWords("league_not_found")).toBe(
      "No league has that code.",
    );
    expect(leagueRefusalWords("server_error")).toBe(
      "That didn't work. Try again.",
    );
  });
});
