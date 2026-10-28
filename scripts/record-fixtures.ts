/**
 * One-off, run by hand: `pnpm tsx scripts/record-fixtures.ts`.
 *
 * Records the raw Jolpica responses that the M2 tests use, into
 * tests/fixtures/jolpica/. It goes through the same rate-limited provider
 * client as the app, so it stays under the configured limits, and it writes each
 * response body unchanged (pretty-printed). Tests never reach the network.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestDb } from "../tests/helpers/test-db";
import { createProviderClient } from "@/providers/http/client";
import { createRateLimiter } from "@/providers/http/rate-limiter";
import { systemClock } from "@/lib/clock";
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function main() {
  const t = await createTestDb();
  const limits = (await getSetting(t.db, "provider_limits")).jolpica;
  const client = createProviderClient({
    provider: "jolpica",
    baseUrl: BASE_URL,
    db: t.db,
    clock: systemClock,
    fetch,
    limiter: createRateLimiter(limits, systemClock, sleep),
    sleep,
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

  const pad = (round: number | string) => String(round).padStart(2, "0");

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
