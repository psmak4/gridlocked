/** Spike: the server functions behind the results and picks pages. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { withDb } from "./db";
import { listPicks, pickInput, savePick } from "./picks";
import { raceResults } from "./results";

/** Task 3 has no sign-in yet; Task 4 replaces this with the session user. */
const SPIKE_USER = "spike-anon";

export const getRaceResults = createServerFn({ method: "GET" })
  .validator(z.object({ round: z.number().int().min(1).max(23) }))
  .handler(({ data }) => withDb((db) => raceResults(db, data.round)));

export const getPicks = createServerFn({ method: "GET" }).handler(() =>
  withDb((db) => listPicks(db, SPIKE_USER)),
);

export const makePick = createServerFn({ method: "POST" })
  .validator(pickInput)
  .handler(({ data }) =>
    withDb(async (db) => {
      await savePick(db, SPIKE_USER, data);
      return listPicks(db, SPIKE_USER);
    }),
  );
