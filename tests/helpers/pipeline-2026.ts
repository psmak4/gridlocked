// Test helper for the pipeline job tests: the real provider clients and
// handlers over a fake `fetch` that serves recorded fixture bodies, so no test
// reaches the network. Like the other helpers it may import src/providers.
import { and, asc, eq } from "drizzle-orm";
import { events, jobs, sessions } from "@/db/schema";
import type { Db } from "@/db/types";
import type { Clock } from "@/lib/clock";
import { createProviderClient } from "@/providers/http/client";
import { createRateLimiter } from "@/providers/http/rate-limiter";
import { createPipelineHandlers } from "@/providers/pipeline";
import { readFixture } from "./fixtures";

export const JOLPICA_PATH = "/ergast/f1";
export const OPENF1_PATH = "/v1";

/** A fresh copy of a recorded Jolpica body, served as-is. */
export const jolpicaFixture = (file: string) =>
  readFixture(`jolpica/2026/${file}`);

/**
 * The OpenF1 session key of the practice session in the recorded session list
 * (same kind, nearest start), as the adapter would link it.
 */
export async function openF1KeyFor(db: Db, sessionId: string): Promise<number> {
  const [ours] = await db
    .select({ kind: sessions.kind, start: sessions.scheduledStart })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  const name = { fp1: "Practice 1", fp2: "Practice 2", fp3: "Practice 3" }[
    ours!.kind as "fp1" | "fp2" | "fp3"
  ];
  const list = readFixture("openf1/2026/sessions.json") as Array<{
    session_key: number;
    session_name: string;
    date_start: string;
  }>;
  const best = list
    .filter((s) => s.session_name === name)
    .map((s) => ({
      key: s.session_key,
      gap: Math.abs(Date.parse(s.date_start) - ours!.start.getTime()),
    }))
    .sort((a, b) => a.gap - b.gap)[0];
  if (!best) throw new Error(`no OpenF1 ${name}`);
  return best.key;
}

/**
 * The pipeline handlers on the real clients and a fake `fetch`. `serve(path,
 * body)` sets what a URL path answers (a function is called per request, so a
 * test can change the answer over time); an unserved path is a 404. OpenF1
 * `drivers` is served per session with `serve("/v1/drivers#<key>", ...)`.
 */
export function makePipeline(db: Db, clock: Clock) {
  const routes = new Map<string, unknown | (() => unknown)>();
  /** Every request made, as `pathname` or `pathname#session_key`. */
  const calls: string[] = [];

  const route = (url: URL) => {
    const key = url.searchParams.get("session_key");
    return key === null ? url.pathname : `${url.pathname}#${key}`;
  };
  const fakeFetch = (async (input: string | URL | Request) => {
    const r = route(new URL(String(input)));
    calls.push(r);
    if (!routes.has(r)) return new Response("not found", { status: 404 });
    const served = routes.get(r);
    const body = typeof served === "function" ? served() : served;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const sleep = async () => {};
  const client = (provider: "jolpica" | "openf1", baseUrl: string) =>
    createProviderClient({
      provider,
      baseUrl,
      db,
      clock,
      fetch: fakeFetch,
      limiter: createRateLimiter({ perSecond: 1000 }, clock, sleep),
      sleep,
    });
  const handlers = createPipelineHandlers({
    jolpica: client("jolpica", `https://api.jolpi.ca${JOLPICA_PATH}`),
    openf1: client("openf1", `https://api.openf1.org${OPENF1_PATH}`),
  });

  return {
    handlers,
    calls,
    serve(path: string, body: unknown | (() => unknown)) {
      routes.set(path, body);
    },
  };
}

/** The ids of round `round`'s event and the sessions by kind. */
export async function eventOfRound(db: Db, round: number) {
  const [event] = await db.select().from(events).where(eq(events.round, round));
  if (!event) throw new Error(`no round ${round}`);
  const rows = await db
    .select()
    .from(sessions)
    .where(eq(sessions.eventId, event.id))
    .orderBy(asc(sessions.scheduledStart));
  return { event, sessions: rows };
}

export async function sessionOf(db: Db, eventId: string, kind: string) {
  const [row] = await db
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.eventId, eventId),
        eq(sessions.kind, kind as typeof sessions.$inferSelect.kind),
      ),
    );
  if (!row) throw new Error(`no ${kind} session`);
  return row;
}

/** All jobs, oldest run_at first. */
export const allJobs = (db: Db) =>
  db.select().from(jobs).orderBy(asc(jobs.runAt), asc(jobs.dedupeKey));
