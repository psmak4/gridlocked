/**
 * One-off, run by hand: `pnpm tsx scripts/record-jolpica-2026.ts [--through=19]`.
 *
 * Records the 2026 results the season replay serves, into
 * tests/fixtures/jolpica/2026/: `r<NN>-qualifying.json` and
 * `r<NN>-results.json` for every round through `--through`, and
 * `r<NN>-sprint.json` for the rounds whose calendar entry has a sprint. A file
 * that is already recorded stays byte for byte; only what's missing is
 * fetched. Then it checks every round has its files, for its own round.
 *
 * Add a round by raising `RECORDED_THROUGH_ROUND`
 * (tests/helpers/recorded-2026.ts) once its results are final.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RECORDED_THROUGH_ROUND } from "../tests/helpers/recorded-2026";
import {
  jolpicaFixturesRoot,
  openJolpicaRecorder,
  pad,
  type MRData,
} from "./lib/jolpica-recorder";

const readRecorded = (file: string) =>
  JSON.parse(readFileSync(join(jolpicaFixturesRoot, file), "utf8")) as {
    MRData: MRData;
  };

/** The rounds to record, and whether each has a sprint, from the recorded calendar. */
function roundsThrough(through: number) {
  const races = readRecorded("2026.json").MRData.RaceTable?.Races ?? [];
  const rounds = races
    .filter((race) => Number(race.round) <= through)
    .map((race) => ({
      round: Number(race.round),
      sprint: race.Sprint !== undefined,
    }));
  if (rounds.length !== through) {
    throw new Error(`the calendar has ${rounds.length} of ${through} rounds`);
  }
  return rounds;
}

/** The endpoint and file of each session a round should have recorded. */
function filesOf(round: number, sprint: boolean) {
  const kinds = ["qualifying", ...(sprint ? ["sprint"] : []), "results"];
  return kinds.map((kind) => ({
    kind,
    endpoint: `/2026/${round}/${kind}.json`,
    file: `2026/r${pad(round)}-${kind}.json`,
  }));
}

async function main() {
  const flag = process.argv.find((a) => a.startsWith("--through="));
  const through = flag
    ? Number(flag.slice("--through=".length))
    : RECORDED_THROUGH_ROUND;
  const rounds = roundsThrough(through);
  const wanted = rounds.flatMap(({ round, sprint }) =>
    filesOf(round, sprint).map((f) => ({ ...f, round })),
  );

  const { record, calls, close } = await openJolpicaRecorder();
  for (const { endpoint, file } of wanted) {
    if (existsSync(join(jolpicaFixturesRoot, file))) {
      console.log(`kept ${file}`);
      continue;
    }
    await record(endpoint, file, { expectRaces: true });
  }
  await close();

  for (const { round, file } of wanted) {
    const races = readRecorded(file).MRData.RaceTable?.Races ?? [];
    if (races.length !== 1 || Number(races[0]!.round) !== round) {
      throw new Error(`${file} does not hold round ${round}`);
    }
  }
  console.log(`done: ${calls()} calls, ${wanted.length} files checked`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
