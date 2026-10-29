/**
 * The fake `fetch` of the 2026 replay (HLD §12): the real provider clients
 * talk to this instead of the network, and it answers from the recorded
 * fixtures as the simulated clock moves. Adapter code, because it knows both
 * providers' URLs and the shape of Jolpica's bodies.
 *
 * - Jolpica results: before a session's results are published (its
 *   `scheduled_end` plus the publish delay) the answer is Jolpica's real
 *   "nothing yet" body (`r23-results-empty.json`, rewritten for this season
 *   and round); after, the recorded body. A `penalty` injection reworks the
 *   race body from its time on.
 * - Jolpica calendar, drivers and constructors, and OpenF1's session list:
 *   the recorded bodies. OpenF1 `drivers` is the recorded body of that
 *   session when there is one, else an empty array.
 * - An `outage` injection answers every request with a 503.
 * - Anything else is a 404: the replay only knows its own weekend.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Injection } from "@/replay/injections";
import { applyPenalty } from "./penalty";

const JOLPICA_PATH = "/ergast/f1";
const OPENF1_PATH = "/v1";
const DAY_MS = 24 * 3_600_000;

/** Jolpica's endpoint for each scored kind, and the fixture suffix it is recorded under. */
const RESULTS: Record<string, { kind: string; suffix: string } | undefined> = {
  results: { kind: "race", suffix: "results" },
  sprint: { kind: "sprint", suffix: "sprint" },
  qualifying: { kind: "qualifying", suffix: "qualifying" },
};

export interface ReplaySession {
  kind: string;
  scheduledEnd: Date;
}

export interface ReplayFetchOptions {
  /** The root that holds `jolpica/` and `openf1/`. */
  fixturesDir: string;
  season: number;
  round: number;
  /** The simulated time, read at each request. */
  now: () => Date;
  /** The target event's scored sessions that the replay runs. */
  sessions: ReplaySession[];
  /** Results are published this long after the session's scheduled end. */
  publishDelayMs: number;
  injections: Injection[];
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export function createReplayFetch(opts: ReplayFetchOptions): typeof fetch {
  const { fixturesDir, season, round } = opts;
  const jolpicaDir = join(fixturesDir, "jolpica", String(season));
  const openf1Dir = join(fixturesDir, "openf1", String(season));
  const cache = new Map<string, unknown>();

  const read = (path: string): unknown => {
    if (!cache.has(path))
      cache.set(path, JSON.parse(readFileSync(path, "utf8")));
    return structuredClone(cache.get(path));
  };

  const resultsFile = (suffix: string) =>
    join(jolpicaDir, `r${String(round).padStart(2, "0")}-${suffix}.json`);

  /** OpenF1 session key -> recorded drivers file, found the way the import links sessions. */
  let driverFiles: Map<string, string> | undefined;
  const openF1DriverFiles = () => {
    if (driverFiles) return driverFiles;
    driverFiles = new Map();
    const list = read(join(openf1Dir, "sessions.json")) as Array<{
      session_key: number;
      session_name: string;
      date_start: string;
    }>;
    const calendar = read(join(fixturesDir, "jolpica", `${season}.json`)) as {
      MRData: { RaceTable: { Races: Array<{ round: string; date: string }> } };
    };
    for (const file of readdirSync(openf1Dir).sort()) {
      const m = /^drivers-r(\d{2})-fp([123])\.json$/.exec(file);
      if (!m) continue;
      const race = calendar.MRData.RaceTable.Races.find(
        (r) => Number(r.round) === Number(m[1]),
      );
      if (!race)
        throw new Error(`replay: ${file} is for a round not in the calendar`);
      const raceAt = Date.parse(`${race.date}T00:00:00Z`);
      const best = list
        .filter((s) => s.session_name === `Practice ${m[2]}`)
        .map((s) => ({
          key: s.session_key,
          gap: Math.abs(Date.parse(s.date_start) - raceAt),
        }))
        .filter((s) => s.gap <= 5 * DAY_MS)
        .sort((a, b) => a.gap - b.gap)[0];
      if (!best) throw new Error(`replay: OpenF1 has no session for ${file}`);
      driverFiles.set(String(best.key), join(openf1Dir, file));
    }
    return driverFiles;
  };

  const emptyResults = (endpoint: string) => {
    const body = read(join(jolpicaDir, "r23-results-empty.json")) as {
      MRData: { url: string; RaceTable: { season: string; round: string } };
    };
    body.MRData.url = `https://api.jolpi.ca${JOLPICA_PATH}/${season}/${round}/${endpoint}.json`;
    body.MRData.RaceTable.season = String(season);
    body.MRData.RaceTable.round = String(round);
    return body;
  };

  function jolpicaResults(endpoint: string, now: Date): Response {
    const served = RESULTS[endpoint];
    const session = opts.sessions.find((s) => s.kind === served?.kind);
    if (!served || !session) return json({ error: "not replayed" }, 404);

    const publishAt = session.scheduledEnd.getTime() + opts.publishDelayMs;
    const file = resultsFile(served.suffix);
    if (now.getTime() < publishAt || !existsSync(file)) {
      return json(emptyResults(endpoint));
    }
    let body = read(file);
    if (served.kind === "race") {
      const penalties = opts.injections
        .filter(
          (i) => i.kind === "penalty" && Date.parse(i.at) <= now.getTime(),
        )
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
      for (const p of penalties) {
        if (p.kind === "penalty")
          body = applyPenalty(body, p.driver, p.seconds);
      }
    }
    return json(body);
  }

  return (async (input: string | URL | Request) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    const now = opts.now();
    const outage = opts.injections.some(
      (i) =>
        i.kind === "outage" &&
        Date.parse(i.at) <= now.getTime() &&
        now.getTime() < Date.parse(i.until),
    );
    if (outage) return new Response("Service Unavailable", { status: 503 });

    const path = url.pathname;
    if (path.startsWith(`${JOLPICA_PATH}/`)) {
      const rest = path.slice(JOLPICA_PATH.length);
      if (rest === `/${season}.json`) {
        return json(read(join(fixturesDir, "jolpica", `${season}.json`)));
      }
      const roster = /^\/(\d{4})\/(drivers|constructors)\.json$/.exec(rest);
      if (roster && Number(roster[1]) === season) {
        return json(read(join(jolpicaDir, `${roster[2]}.json`)));
      }
      const results = /^\/(\d{4})\/(\d+)\/(\w+)\.json$/.exec(rest);
      if (
        results &&
        Number(results[1]) === season &&
        Number(results[2]) === round
      ) {
        return jolpicaResults(results[3]!, now);
      }
    } else if (path.startsWith(`${OPENF1_PATH}/`)) {
      const rest = path.slice(OPENF1_PATH.length);
      if (rest === "/sessions") {
        return json(read(join(openf1Dir, "sessions.json")));
      }
      if (rest === "/drivers") {
        const file = openF1DriverFiles().get(
          url.searchParams.get("session_key") ?? "",
        );
        return json(file ? read(file) : []);
      }
    }
    return json({ error: "not replayed" }, 404);
  }) as typeof fetch;
}
