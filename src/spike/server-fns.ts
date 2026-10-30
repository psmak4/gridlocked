/** Spike: the server functions behind the results and picks pages. */
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { withDb } from "./db";
import { listPicks, pickInput, savePick } from "./picks";
import { raceResults } from "./results";
import { requireUser } from "./session";

export const getRaceResults = createServerFn({ method: "GET" })
  .validator(z.object({ round: z.number().int().min(1).max(23) }))
  .handler(({ data }) => withDb((db) => raceResults(db, data.round)));

export const getPicks = createServerFn({ method: "GET" }).handler(async () => {
  const user = await requireUser();
  return withDb((db) => listPicks(db, user.id));
});

export const makePick = createServerFn({ method: "POST" })
  .validator(pickInput)
  .handler(async ({ data }) => {
    const user = await requireUser();
    return withDb(async (db) => {
      await savePick(db, user.id, data);
      return listPicks(db, user.id);
    });
  });
