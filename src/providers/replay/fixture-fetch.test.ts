import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readFixture } from "../../../tests/helpers/fixtures";
import { createReplayFetch } from "./fixture-fetch";

// The fake `fetch` the replay serves the provider clients with (Task 11b).

const FIXTURES = fileURLToPath(
  new URL("../../../tests/fixtures", import.meta.url),
);
const QUALI_END = new Date("2026-10-24T22:00:00.000Z");
const RACE_END = new Date("2026-10-25T22:00:00.000Z");
const minutes = (from: Date, n: number) =>
  new Date(from.getTime() + n * 60_000);

const JOLPICA = "https://api.jolpi.ca/ergast/f1";
const OPENF1 = "https://api.openf1.org/v1";
const RACE = `${JOLPICA}/2026/18/results.json?limit=100`;

function setup(
  opts: {
    now?: Date;
    injections?: Parameters<typeof createReplayFetch>[0]["injections"];
    publishDelayMs?: number;
  } = {},
) {
  const clock = { at: opts.now ?? RACE_END };
  const fetch = createReplayFetch({
    fixturesDir: FIXTURES,
    season: 2026,
    round: 18,
    now: () => clock.at,
    sessions: [
      { kind: "qualifying", scheduledEnd: QUALI_END },
      { kind: "race", scheduledEnd: RACE_END },
    ],
    publishDelayMs: opts.publishDelayMs ?? 30 * 60_000,
    injections: opts.injections ?? [],
  });
  return { clock, fetch };
}

type Served = {
  MRData: {
    RaceTable: {
      Races: Array<{ Results: Array<{ Driver: { driverId: string } }> }>;
    };
  };
};
const json = async (response: Response) => (await response.json()) as Served;
const jsonOf = async <T>(response: Response) => (await response.json()) as T;
const orderOf = (body: Served) =>
  body.MRData.RaceTable.Races[0]!.Results.map((r) => r.Driver.driverId);

describe("createReplayFetch: Jolpica results", () => {
  it("serves Jolpica's real empty shape, for this season and round, before publication", async () => {
    const { fetch } = setup({ now: minutes(RACE_END, 29) });
    const response = await fetch(RACE);
    expect(response.status).toBe(200);
    const body = await json(response);
    const empty = structuredClone(
      readFixture("jolpica/2026/r23-results-empty.json"),
    ) as { MRData: { url: string; RaceTable: { round: string } } };
    empty.MRData.url = "https://api.jolpi.ca/ergast/f1/2026/18/results.json";
    empty.MRData.RaceTable.round = "18";
    expect(body).toEqual(empty);
  });

  it("serves the recorded body from the publish time on", async () => {
    const { fetch } = setup({ now: minutes(RACE_END, 30) });
    expect(await json(await fetch(RACE))).toEqual(
      readFixture("jolpica/2026/r18-results.json"),
    );
  });

  it("publishes after the configured delay", async () => {
    const { fetch, clock } = setup({
      now: minutes(RACE_END, 30),
      publishDelayMs: 90 * 60_000,
    });
    const early = await json(await fetch(RACE));
    expect(early.MRData.RaceTable.Races).toEqual([]);
    clock.at = minutes(RACE_END, 90);
    const late = await json(await fetch(RACE));
    expect(late.MRData.RaceTable.Races).toHaveLength(1);
  });

  it("serves qualifying under its own endpoint and end time", async () => {
    const { fetch } = setup({ now: minutes(QUALI_END, 31) });
    const body = await json(
      await fetch(`${JOLPICA}/2026/18/qualifying.json?limit=100`),
    );
    expect(body).toEqual(readFixture("jolpica/2026/r18-qualifying.json"));
  });

  it("answers 404 for anything it has no session for", async () => {
    const { fetch } = setup();
    expect(
      (await fetch(`${JOLPICA}/2026/18/sprint.json?limit=100`)).status,
    ).toBe(404);
    expect(
      (await fetch(`${JOLPICA}/2026/17/results.json?limit=100`)).status,
    ).toBe(404);
    expect((await fetch(`${OPENF1}/laps`)).status).toBe(404);
  });
});

describe("createReplayFetch: injections", () => {
  const penalty = {
    at: "2026-10-25T23:00:00Z",
    kind: "penalty",
    driver: "max_verstappen",
    seconds: 5,
  } as const;

  it("serves the penalised race from the injection's time on, not before", async () => {
    const { fetch, clock } = setup({
      now: new Date("2026-10-25T22:59:00Z"),
      injections: [penalty],
    });
    const before = await json(await fetch(RACE));
    expect(orderOf(before)[2]).toBe("max_verstappen");
    clock.at = new Date("2026-10-25T23:00:00Z");
    const after = await json(await fetch(RACE));
    expect(orderOf(after)[2]).toBe("hamilton");
  });

  it("answers 503 to every request inside an outage, and normally after it", async () => {
    const { fetch, clock } = setup({
      now: new Date("2026-10-25T21:59:59Z"),
      injections: [
        {
          at: "2026-10-25T22:00:00Z",
          kind: "outage",
          until: "2026-10-26T01:00:00Z",
        },
      ],
    });
    expect((await fetch(RACE)).status).toBe(200);
    clock.at = new Date("2026-10-25T22:00:00Z");
    expect((await fetch(RACE)).status).toBe(503);
    expect((await fetch(`${OPENF1}/sessions?year=2026`)).status).toBe(503);
    clock.at = new Date("2026-10-26T00:59:59Z");
    expect((await fetch(RACE)).status).toBe(503);
    clock.at = new Date("2026-10-26T01:00:00Z");
    expect((await fetch(RACE)).status).toBe(200);
  });
});

describe("createReplayFetch: reference data and OpenF1", () => {
  it("serves the recorded calendar, drivers and constructors", async () => {
    const { fetch } = setup();
    expect(await json(await fetch(`${JOLPICA}/2026.json?limit=100`))).toEqual(
      readFixture("jolpica/2026.json"),
    );
    expect(
      await json(await fetch(`${JOLPICA}/2026/drivers.json?limit=100`)),
    ).toEqual(readFixture("jolpica/2026/drivers.json"));
    expect(
      await json(await fetch(`${JOLPICA}/2026/constructors.json?limit=100`)),
    ).toEqual(readFixture("jolpica/2026/constructors.json"));
  });

  it("serves the OpenF1 session list, and each session's recorded drivers or an empty array", async () => {
    const { fetch } = setup();
    const list = await jsonOf<Array<{ session_key: number }>>(
      await fetch(`${OPENF1}/sessions?year=2026`),
    );
    expect(list).toEqual(readFixture("openf1/2026/sessions.json"));

    const recorded: number[] = [];
    for (const { session_key } of list) {
      const drivers = await jsonOf<unknown[]>(
        await fetch(`${OPENF1}/drivers?session_key=${session_key}`),
      );
      if (drivers.length > 0) recorded.push(session_key);
    }
    // Four practice sessions are recorded (r12 FP1, r13 FP2 and FP3, r15 FP2),
    // none of them in round 18 (keys 11389 to 11391).
    expect(recorded).toHaveLength(4);
    expect(recorded.filter((k) => k >= 11389 && k <= 11396)).toEqual([]);
  });
});
