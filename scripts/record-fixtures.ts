/**
 * One-off, run by hand: `pnpm tsx scripts/record-fixtures.ts`.
 *
 * Records the raw Jolpica responses that the M2 tests use, into
 * tests/fixtures/jolpica/. It goes through the same rate-limited provider
 * client as the app, so it stays under the configured limits, and it writes each
 * response body unchanged (pretty-printed). Tests never reach the network.
 *
 * `--openf1` records the OpenF1 practice participants instead (into
 * tests/fixtures/openf1/), see `recordOpenF1`. `--openf1=sessions` records only
 * the session list.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestDb } from "../tests/helpers/test-db";
import { createProviderClient } from "@/providers/http/client";
import { createRateLimiter } from "@/providers/http/rate-limiter";
import { systemClock, systemTimer } from "@/lib/clock";
import { getSetting } from "@/settings";

const BASE_URL = "https://api.jolpi.ca/ergast/f1";
const PAGE_SIZE = 100;
const outRoot = fileURLToPath(
  new URL("../tests/fixtures/jolpica", import.meta.url),
);

interface MRData {
  total?: string;
  limit?: string;
  offset?: string;
  RaceTable?: { Races?: Array<Record<string, unknown>> };
}

const OPENF1_BASE_URL = "https://api.openf1.org/v1";
const openf1Root = fileURLToPath(
  new URL("../tests/fixtures/openf1", import.meta.url),
);

/** The practice sessions whose participants the roster check tests use. */
const OPENF1_TARGETS: Array<{ round: number; sessions: string[] }> = [
  // The first swap weekend (Dutch GP). A sprint weekend: FP1 only.
  { round: 12, sessions: ["Practice 1"] },
  // The next swap weekend that has FP2 and FP3.
  { round: 13, sessions: ["Practice 2", "Practice 3"] },
  // The reversal weekend.
  { round: 15, sessions: ["Practice 2"] },
];

interface OpenF1Session {
  session_key: number;
  session_name: string;
  date_start: string;
}

/**
 * Records `sessions?year=2026` and then `drivers?session_key=<k>` for each
 * target practice session (found by name and by the race weekend's dates in the
 * recorded Jolpica calendar). Goes through the same rate-limited client, under
 * the configured OpenF1 limits.
 */
async function recordOpenF1(onlySessions: boolean) {
  const t = await createTestDb();
  const limits = (await getSetting(t.db, "provider_limits")).openf1;
  const client = createProviderClient({
    provider: "openf1",
    baseUrl: OPENF1_BASE_URL,
    db: t.db,
    clock: systemClock,
    fetch,
    limiter: createRateLimiter(limits, systemTimer),
    timer: systemTimer,
  });
  let calls = 0;
  async function record(
    endpoint: string,
    params: Record<string, string>,
    file: string,
  ) {
    calls++;
    const res = await client.get(endpoint, params);
    const path = join(openf1Root, file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(res.body, null, 2) + "\n");
    console.log(`${calls}. ${endpoint} ${JSON.stringify(params)} -> ${file}`);
    return res.body;
  }

  const list = (await record(
    "/sessions",
    { year: "2026" },
    "2026/sessions.json",
  )) as OpenF1Session[];
  if (!Array.isArray(list)) throw new Error("sessions: expected an array");
  if (onlySessions) {
    console.log(`done: ${calls} calls`);
    await t.close();
    return;
  }

  const calendar = JSON.parse(
    await readFile(
      fileURLToPath(
        new URL("../tests/fixtures/jolpica/2026.json", import.meta.url),
      ),
      "utf8",
    ),
  ) as { MRData: MRData };
  const races = calendar.MRData.RaceTable?.Races ?? [];
  for (const target of OPENF1_TARGETS) {
    const race = races.find((r) => Number(r.round) === target.round);
    if (!race) throw new Error(`no round ${target.round} in the calendar`);
    const raceDay = Date.parse(`${String(race.date)}T00:00:00Z`);
    for (const name of target.sessions) {
      const matches = list.filter((s) => {
        const start = Date.parse(s.date_start);
        return (
          s.session_name === name &&
          start >= raceDay - 3 * 86_400_000 &&
          start < raceDay + 86_400_000
        );
      });
      if (matches.length !== 1) {
        throw new Error(
          `round ${target.round} ${name}: ${matches.length} matching sessions`,
        );
      }
      const key = matches[0]!.session_key;
      const slug = name.replace("Practice ", "fp");
      await record(
        "/drivers",
        { session_key: String(key) },
        `2026/drivers-r${pad(target.round)}-${slug}.json`,
      );
    }
  }
  console.log(`done: ${calls} calls`);
  await t.close();
}

const pad = (round: number | string) => String(round).padStart(2, "0");

async function main() {
  const openf1 = process.argv.find((a) => a.startsWith("--openf1"));
  if (openf1) {
    await recordOpenF1(openf1 === "--openf1=sessions");
    return;
  }
  const t = await createTestDb();
  const limits = (await getSetting(t.db, "provider_limits")).jolpica;
  const client = createProviderClient({
    provider: "jolpica",
    baseUrl: BASE_URL,
    db: t.db,
    clock: systemClock,
    fetch,
    limiter: createRateLimiter(limits, systemTimer),
    timer: systemTimer,
  });

  const written = new Set<string>();
  let calls = 0;

  /** Fetches `endpoint` (and any further pages) and saves the raw bodies. */
  async function record(
    endpoint: string,
    file: string,
    opts: { expectRaces?: boolean } = {},
  ): Promise<MRData> {
    if (written.has(file)) throw new Error(`duplicate fixture ${file}`);
    written.add(file);
    let first: MRData | undefined;
    for (let offset = 0, page = 1; ; page++) {
      calls++;
      const res = await client.get(endpoint, {
        limit: String(PAGE_SIZE),
        offset: String(offset),
      });
      const mr = (res.body as { MRData: MRData }).MRData;
      first ??= mr;
      const name =
        page === 1 ? file : file.replace(/\.json$/, `.p${page}.json`);
      const path = join(outRoot, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, JSON.stringify(res.body, null, 2) + "\n");
      console.log(`${calls}. ${endpoint} offset=${offset} -> ${name}`);
      if (opts.expectRaces && !(mr.RaceTable?.Races?.length ?? 0)) {
        throw new Error(`${endpoint}: no races in the response`);
      }
      const total = Number(mr.total ?? 0);
      offset += PAGE_SIZE;
      if (offset >= total) break;
    }
    return first;
  }

  // `--rounds=15,16,17` records only those 2026 race results (a later top-up).
  const extra = process.argv.find((a) => a.startsWith("--rounds="));
  if (extra) {
    for (const round of extra.slice("--rounds=".length).split(",")) {
      await record(
        `/2026/${round}/results.json`,
        `2026/r${pad(round)}-results.json`,
        { expectRaces: true },
      );
    }
    console.log(`done: ${calls} calls`);
    await t.close();
    return;
  }

  // `--empty=23` records the "not published yet" answer for a round that has
  // not run: Jolpica returns an empty Races list, not an error.
  const empty = process.argv.find((a) => a.startsWith("--empty="));
  if (empty) {
    const round = empty.slice("--empty=".length);
    const mr = await record(
      `/2026/${round}/results.json`,
      `2026/r${pad(round)}-results-empty.json`,
    );
    if ((mr.RaceTable?.Races?.length ?? 0) !== 0) {
      throw new Error(`round ${round} already has results`);
    }
    console.log(`done: ${calls} calls`);
    await t.close();
    return;
  }

  const calendar = await record("/2026.json", "2026.json", {
    expectRaces: true,
  });
  await record("/2026/drivers.json", "2026/drivers.json");
  await record("/2026/constructors.json", "2026/constructors.json");

  const today = systemClock.now().toISOString().slice(0, 10);
  const races = calendar.RaceTable?.Races ?? [];
  const sprint = races.find(
    (race) => race.Sprint !== undefined && String(race.date) < today,
  );
  if (!sprint) throw new Error("no completed 2026 sprint weekend found");
  const sprintRound = Number(sprint.round);
  console.log(`sprint weekend: round ${sprintRound} (${String(sprint.date)})`);

  // Round 1: the source of the 2026 seats.
  await record("/2026/1/results.json", "2026/r01-results.json", {
    expectRaces: true,
  });
  // Round 18: qualifying and the race.
  await record("/2026/18/qualifying.json", "2026/r18-qualifying.json", {
    expectRaces: true,
  });
  await record("/2026/18/results.json", "2026/r18-results.json", {
    expectRaces: true,
  });
  // One sprint weekend.
  await record(
    `/2026/${sprintRound}/sprint.json`,
    `2026/r${pad(sprintRound)}-sprint.json`,
    { expectRaces: true },
  );
  const doneResults = new Set([
    "2026/r01-results.json",
    "2026/r18-results.json",
  ]);
  const sprintResults = `2026/r${pad(sprintRound)}-results.json`;
  if (!doneResults.has(sprintResults)) {
    await record(`/2026/${sprintRound}/results.json`, sprintResults, {
      expectRaces: true,
    });
    doneResults.add(sprintResults);
  }
  // China 2025: Hamilton and Leclerc were disqualified.
  await record("/2025/2/results.json", "2025/r02-results.json", {
    expectRaces: true,
  });
  // The rounds around the Lawson / Tsunoda / Hadjar swap.
  for (const round of [12, 13, 14, 15, 16, 17]) {
    const file = `2026/r${pad(round)}-results.json`;
    if (doneResults.has(file)) continue;
    await record(`/2026/${round}/results.json`, file, { expectRaces: true });
    doneResults.add(file);
  }

  console.log(`done: ${calls} calls`);
  await t.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
