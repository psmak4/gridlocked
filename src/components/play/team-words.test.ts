import { describe, expect, it } from "vitest";
import type { ChipState, PoolRow } from "@/play/builder";
import type { TeamPreview } from "@/play/preview";
import {
  chipRow,
  chipsLeft,
  chipWords,
  clockTime,
  lateCallWords,
  countdownTick,
  inactiveWords,
  lockCountdown,
  overCapWords,
  penaltyWords,
  problemWords,
  teamWords,
  transferNote,
  transferStat,
} from "./team-words";

const LOCK = "2026-09-06T13:00:00.000Z";
const LONDON = { lockAt: LOCK, timeZone: "Europe/London" };

describe("teamWords", () => {
  it("window_closed says when the team locked, in the viewer's time", () => {
    expect(teamWords("window_closed", LONDON)).toBe(
      "Your team locked at 14:00.",
    );
    expect(teamWords("window_closed", { ...LONDON, timeZone: "UTC" })).toBe(
      "Your team locked at 13:00.",
    );
    expect(teamWords("window_closed", { ...LONDON, lockAt: null })).toBe(
      "Your team is locked for now.",
    );
  });

  it("over_budget", () => {
    expect(teamWords("over_budget", LONDON)).toBe(
      "Your team is over the cap at the latest prices. Swap a driver to save.",
    );
  });

  it("asset_unavailable", () => {
    expect(teamWords("asset_unavailable", LONDON)).toBe(
      "One of your picks can't be picked any more. Swap it to save.",
    );
  });

  it("composition", () => {
    expect(teamWords("composition", LONDON)).toBe(
      "Your team isn't complete. Check your drivers, constructors and Boost.",
    );
  });

  it("team_retired", () => {
    expect(teamWords("team_retired", LONDON)).toBe(
      "This team is retired, so it can't be changed.",
    );
  });

  it("team_not_owned", () => {
    expect(teamWords("team_not_owned", LONDON)).toBe("That team isn't yours.");
  });

  it("game_not_open", () => {
    expect(teamWords("game_not_open", LONDON)).toBe("The game isn't open yet.");
  });

  it("a server error, or a code the builder never gets", () => {
    for (const code of ["server_error", "league_full"] as const) {
      expect(teamWords(code, LONDON)).toBe(
        "Your team wasn't saved. Try again.",
      );
    }
  });
});

describe("clockTime", () => {
  it("an unknown time zone falls back to UTC", () => {
    expect(clockTime(LOCK, "Not/AZone")).toBe("13:00");
  });
});

describe("lockCountdown", () => {
  const MIN = 60_000;
  it("days, then hours and minutes, then minutes and seconds", () => {
    expect(lockCountdown(((24 + 4) * 60 + 12) * MIN)).toBe("1D 04:12");
    expect(lockCountdown((4 * 60 + 12) * MIN + 59_000)).toBe("04:12");
    expect(lockCountdown(10 * MIN)).toBe("00:10");
    expect(lockCountdown(9 * MIN + 59_400)).toBe("10:00");
    expect(lockCountdown(9 * MIN + 59_000)).toBe("09:59");
    expect(lockCountdown(1)).toBe("00:01");
    expect(lockCountdown(0)).toBe("LOCKED");
  });

  it("ticks every minute, and every second in the last 10 minutes", () => {
    expect(countdownTick(60 * MIN + 30_000)).toBe(30_000);
    expect(countdownTick(60 * MIN)).toBe(MIN);
    expect(countdownTick(5 * MIN + 250)).toBe(250);
    expect(countdownTick(5 * MIN)).toBe(1000);
  });
});

const preview = (over: Partial<TeamPreview>): TeamPreview => ({
  spent: 980,
  overBy: 0,
  transfers: 1,
  free: 2,
  extra: 0,
  penalty: 0,
  problems: [],
  ...over,
});

describe("the over-the-cap and penalty sentences", () => {
  it("over the cap says by how much", () => {
    expect(overCapWords(14)).toBe(
      "You're $1.4M over the cap. Swap one driver to save.",
    );
  });

  it("one extra transfer is the third", () => {
    expect(
      penaltyWords(preview({ transfers: 3, extra: 1, penalty: -10 })),
    ).toBe("3 changes this week. 2 are free, so the third costs 10 points.");
  });

  it("more extra transfers, one free, none free", () => {
    expect(
      penaltyWords(preview({ transfers: 4, extra: 2, penalty: -20 })),
    ).toBe("4 changes this week. 2 are free, so the other 2 cost 20 points.");
    expect(
      penaltyWords(preview({ transfers: 2, free: 1, extra: 1, penalty: -10 })),
    ).toBe("2 changes this week. 1 is free, so the second costs 10 points.");
    expect(
      penaltyWords(preview({ transfers: 1, free: 0, extra: 1, penalty: -10 })),
    ).toBe("1 change this week. None are free, so it costs 10 points.");
  });

  it("no penalty line within the free ones, or when they're unlimited", () => {
    expect(penaltyWords(preview({}))).toBeNull();
    expect(penaltyWords(preview({ free: null, transfers: 7 }))).toBeNull();
  });

  it("the transfer note and stat", () => {
    expect(transferNote(preview({}))).toBe("1 of 2 free transfers used");
    expect(
      transferNote(preview({ transfers: 3, extra: 1, penalty: -10 })),
    ).toBe("3 changes · 1 costs 10 pts");
    expect(transferNote(preview({ free: null }))).toBe(
      "Unlimited free transfers",
    );
    expect(transferStat(preview({}))).toBe("1/2");
    expect(transferStat(preview({ free: null }))).toBe("Free");
  });
});

describe("problemWords", () => {
  const squad = { drivers: 5, constructors: 2 };
  it("an empty team says what to pick", () => {
    expect(
      problemWords(["drivers", "constructors", "boost"], {
        drivers: 0,
        constructors: 0,
        squad,
      }),
    ).toBe("Pick 5 drivers and 2 constructors to save.");
  });

  it("a part-built team says how many more", () => {
    expect(
      problemWords(["drivers", "boost"], {
        drivers: 4,
        constructors: 2,
        squad,
      }),
    ).toBe("Pick 1 more driver to save.");
    expect(
      problemWords(["constructors"], { drivers: 5, constructors: 0, squad }),
    ).toBe("Pick 2 more constructors to save.");
  });

  it("the Boost, Overdrive and an unpickable asset", () => {
    const full = { drivers: 5, constructors: 2, squad };
    expect(problemWords(["boost"], full)).toBe(
      "Choose one driver for the 2× Boost.",
    );
    expect(problemWords(["x3_target"], full)).toBe(
      "Keep your Overdrive driver, without the 2× Boost.",
    );
    expect(problemWords(["unavailable"], full)).toBe(
      "Swap out the pick that can't be picked any more.",
    );
    expect(problemWords(["over_budget"], full)).toBeNull();
    expect(problemWords([], full)).toBeNull();
  });
});

describe("inactiveWords", () => {
  const row = (title: string, availability: PoolRow["availability"]) =>
    ({ title, availability }) as PoolRow;
  it("names who is out, then who is doubtful", () => {
    expect(
      inactiveWords([
        row("Isack Hadjar", "out"),
        row("Oliver Bearman", "doubtful"),
      ]),
    ).toBe("Isack Hadjar is out this race.");
    expect(
      inactiveWords([row("A", "out"), row("B", "withdrawn"), row("C", "out")]),
    ).toBe("A, B and C are out this race.");
    expect(inactiveWords([row("Oliver Bearman", "doubtful")])).toBe(
      "Oliver Bearman is doubtful for this race.",
    );
    expect(inactiveWords([row("A", "available")])).toBeNull();
  });
});

const chip = (over: Partial<ChipState>): ChipState => ({
  code: "chip_autopilot",
  name: "Strategist",
  effect: "autopilot",
  sentence: "After the weekend, your Boost moves to your top scorer.",
  status: "available",
  playedFor: null,
  ...over,
});
const READY = { anotherPlayed: false, overdriveReady: true };

describe("chipRow", () => {
  it("an available chip can be played", () => {
    expect(chipRow(chip({}), READY)).toEqual({ label: "Play", playable: true });
  });

  it("played, used, and waiting for the second race can't", () => {
    expect(chipRow(chip({ status: "played" }), READY)).toEqual({
      label: "Played",
      playable: false,
    });
    expect(
      chipRow(
        chip({ status: "used", playedFor: "Australian Grand Prix" }),
        READY,
      ),
    ).toEqual({ label: "Used in Australian Grand Prix", playable: false });
    expect(
      chipRow(chip({ status: "locked_until_first_race" }), READY).label,
    ).toBe("From your second race");
  });

  it("Late Call says when it opens; another chip this race blocks the rest", () => {
    expect(
      chipRow(chip({ effect: "final_fix", name: "Late Call" }), READY),
    ).toEqual({ label: "Opens after qualifying", playable: false });
    expect(chipRow(chip({}), { ...READY, anotherPlayed: true })).toEqual({
      label: "One per race",
      playable: false,
    });
  });

  it("Overdrive waits for a saved team", () => {
    expect(
      chipRow(chip({ effect: "triple_boost" }), {
        ...READY,
        overdriveReady: false,
      }),
    ).toEqual({ label: "Save your team first", playable: false });
  });

  it("chips left counts what can still be played this season", () => {
    expect(
      chipsLeft([
        chip({}),
        chip({ status: "locked_until_first_race" }),
        chip({ status: "played" }),
        chip({ status: "used" }),
      ]),
    ).toBe(2);
  });
});

describe("chipWords and lateCallWords", () => {
  it("say why a chip was refused", () => {
    expect(chipWords("chip_unavailable", LONDON)).toBe(
      "That chip can't be played. Each chip works once a season, one per race.",
    );
    expect(chipWords("chip_window_closed", LONDON)).toBe(
      "Your team locked at 14:00, so chips are closed.",
    );
    expect(chipWords("team_retired", LONDON)).toBe(
      "This team is retired, so it can't be changed.",
    );
    expect(chipWords("server_error", LONDON)).toBe(
      "The chip wasn't played. Try again.",
    );
  });

  it("say why a Late Call was refused", () => {
    expect(lateCallWords("chip_window_closed")).toBe(
      "Late Call is closed: it ends when the race starts.",
    );
    expect(lateCallWords("over_budget")).toBe(
      "That swap is over the cap at this race's prices.",
    );
    expect(lateCallWords("server_error")).toBe(
      "Late Call wasn't played. Try again.",
    );
  });
});
