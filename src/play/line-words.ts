/**
 * Points lines in words (M6 Task 11, "My calls"): one entry per scoring rule
 * code, for the breakdown's one-line reason ("P3 · gained 3 places") and the
 * driver sheet's line by line ("Finished P3", "Race finishing position").
 * Pure: the rule code and the line's `detail` in, words out. A code with no
 * entry throws, so a new rule can't ship without words.
 */

type Detail = Record<string, unknown>;

/** A line in the driver sheet: what scored, and why. */
export type SheetWords = { label: string; why: string };

type Words = {
  /** Where the line sits in a row's reason: positions first. */
  order: number;
  short: (detail: Detail) => string;
  sheet: (detail: Detail) => SheetWords;
};

const SESSION_NAMES = {
  qualifying: "Qualifying",
  sprint: "Sprint",
  race: "Race",
} as const;
type Session = keyof typeof SESSION_NAMES;

const num = (detail: Detail, key: string): number | null =>
  typeof detail[key] === "number" ? (detail[key] as number) : null;

const places = (n: number) => `${n} ${n === 1 ? "place" : "places"}`;

/** "Not classified", from a penalty line's classification or reason. */
function whyOut(detail: Detail): string {
  if (detail.reason === "absent") return "Didn't take part";
  if (detail.reason === "no_time") return "No time set";
  switch (detail.classification) {
    case "not_classified":
      return "Not classified";
    case "did_not_start":
      return "Did not start";
    case "did_not_qualify":
      return "Did not qualify";
    case "disqualified":
      return "Disqualified";
    case "excluded":
      return "Excluded";
    default:
      return "Penalty";
  }
}

const position = (session: Session, verb: string): Words => ({
  order: 10,
  short: (d) => `P${num(d, "position") ?? "?"}`,
  sheet: (d) => ({
    label: `${verb} P${num(d, "position") ?? "?"}`,
    why: `${SESSION_NAMES[session]} finishing position`,
  }),
});

const positionsDelta = (): Words => {
  const words = (d: Detail) => {
    const grid = num(d, "grid");
    const at = num(d, "position");
    const moved = grid !== null && at !== null ? grid - at : 0;
    return moved > 0
      ? `gained ${places(moved)}`
      : moved < 0
        ? `lost ${places(-moved)}`
        : "held position";
  };
  return {
    order: 20,
    short: words,
    sheet: (d) => {
      const w = words(d);
      return {
        label: w.charAt(0).toUpperCase() + w.slice(1),
        why: `Started P${num(d, "grid") ?? "?"}, finished P${num(d, "position") ?? "?"}`,
      };
    },
  };
};

const fastestLap = (session: Session): Words => ({
  order: 30,
  short: () => "fastest lap",
  sheet: () => ({
    label: "Fastest lap",
    why: `${SESSION_NAMES[session]} fastest lap`,
  }),
});

const out = (session: Session): Words => ({
  order: 5,
  short: whyOut,
  sheet: (d) => ({
    label: whyOut(d),
    why: `${SESSION_NAMES[session]} penalty`,
  }),
});

/** A constructor's pass-through of its drivers' lines (`aggregate_drivers`). */
const drivers: Words = {
  order: 0,
  short: () => "Both drivers",
  sheet: () => ({ label: "Both drivers", why: "Its drivers' points" }),
};

const disqualified = (session: Session): Words => ({
  order: 50,
  short: () => "a driver disqualified",
  sheet: () => ({
    label: "Driver disqualified",
    why: `${SESSION_NAMES[session]} penalty`,
  }),
});

const KNOCKOUT: Record<string, string> = {
  bothQ3: "both in Q3",
  oneQ3: "one in Q3",
  bothQ2: "both in Q2",
  oneQ2: "one in Q2",
  noneQ2: "neither in Q2",
};

const knockout: Words = {
  order: 40,
  short: (d) => KNOCKOUT[String(d.tier)] ?? "qualifying stage",
  sheet: (d) => {
    const w = KNOCKOUT[String(d.tier)] ?? "qualifying stage";
    return {
      label: w.charAt(0).toUpperCase() + w.slice(1),
      why: "How far its drivers got in qualifying",
    };
  },
};

/** Every 2026 rule code (`SCORING_RULES_2026`). */
const WORDS: Record<string, Words> = {
  "qualifying.position": position("qualifying", "Qualified"),
  "qualifying.not_classified": out("qualifying"),
  "qualifying.drivers": drivers,
  "qualifying.knockout": knockout,
  "qualifying.disqualified": disqualified("qualifying"),
  "sprint.positions": positionsDelta(),
  "sprint.fastest_lap": fastestLap("sprint"),
  "sprint.position": position("sprint", "Finished"),
  "sprint.not_classified": out("sprint"),
  "sprint.drivers": drivers,
  "sprint.disqualified": disqualified("sprint"),
  "race.positions": positionsDelta(),
  "race.fastest_lap": fastestLap("race"),
  "race.position": position("race", "Finished"),
  "race.not_classified": out("race"),
  "race.drivers": drivers,
  "race.disqualified": disqualified("race"),
};

function wordsFor(ruleCode: string): Words {
  const words = WORDS[ruleCode];
  if (!words) throw new Error(`no words for scoring rule "${ruleCode}"`);
  return words;
}

const asDetail = (detail: unknown): Detail =>
  detail !== null && typeof detail === "object" ? (detail as Detail) : {};

/** A line's few words for a breakdown row: "P3", "gained 3 places". */
export function lineWords(ruleCode: string, detail: unknown): string {
  return wordsFor(ruleCode).short(asDetail(detail));
}

/** A line in the driver sheet: "Finished P3" / "Race finishing position". */
export function sheetWords(ruleCode: string, detail: unknown): SheetWords {
  return wordsFor(ruleCode).sheet(asDetail(detail));
}

/**
 * A row's reason: its lines' words in order (positions first), each once,
 * joined with " · ", with the first letter a capital. No lines: "No points".
 */
export function rowReason(
  lines: Array<{ ruleCode: string; detail: unknown }>,
): string {
  const parts: string[] = [];
  const sorted = [...lines].sort(
    (a, b) => wordsFor(a.ruleCode).order - wordsFor(b.ruleCode).order,
  );
  for (const line of sorted) {
    const words = lineWords(line.ruleCode, line.detail);
    if (!parts.includes(words)) parts.push(words);
  }
  if (parts.length === 0) return "No points";
  const text = parts.join(" · ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}
