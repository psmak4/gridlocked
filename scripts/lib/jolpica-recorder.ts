/**
 * What the Jolpica recording scripts share: the same rate-limited provider
 * client as the app, so a recording stays under the configured limits, and a
 * `record` that writes each response body unchanged (pretty-printed) under
 * tests/fixtures/jolpica/. Tests never reach the network.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestDb } from "../../tests/helpers/test-db";
import { createProviderClient } from "@/providers/http/client";
import { createRateLimiter } from "@/providers/http/rate-limiter";
import { systemClock, systemTimer } from "@/lib/clock";
import { getSetting } from "@/settings";

const BASE_URL = "https://api.jolpi.ca/ergast/f1";
const PAGE_SIZE = 100;

export const jolpicaFixturesRoot = fileURLToPath(
  new URL("../../tests/fixtures/jolpica", import.meta.url),
);

export interface MRData {
  total?: string;
  limit?: string;
  offset?: string;
  RaceTable?: { Races?: Array<Record<string, unknown>> };
}

export const pad = (round: number | string) => String(round).padStart(2, "0");

/** A client under the configured Jolpica limits, and a `record` on top of it. */
export async function openJolpicaRecorder() {
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
      const path = join(jolpicaFixturesRoot, name);
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

  return { record, calls: () => calls, close: () => t.close() };
}
