import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../../../tests/helpers/test-db";
import { createMemoryDueStore } from "../../../tests/helpers/memory-due-store";
import { DUE_KEY, type DueFile } from "../due-times";
import { enqueue } from "../queue";
import type { JobHandler } from "../runner";

// The real Pool opens a WebSocket on first use; here its constructor only
// records that it was built.
const pools: unknown[] = [];
vi.mock("@neondatabase/serverless", () => ({
  Pool: class {
    on = vi.fn();
    end = vi.fn(async () => {});
    constructor() {
      pools.push(this);
    }
  },
}));

import tickFunction, {
  FUNCTION_TICK_OPTIONS,
  createTickHandler,
  depsFromEnv,
  type TickHandlerDeps,
} from "./tick";

const T0 = new Date("2026-03-01T10:00:00.000Z");

const file = (nextDueAt: string | null): string =>
  JSON.stringify({
    version: 1,
    generated_at: "2026-03-01T09:59:00.000Z",
    next_due_at: nextDueAt,
  } satisfies DueFile);

const body = (scheduledAt: string | null = T0.toISOString()) =>
  JSON.stringify({
    version: 1,
    invocation_id: "inv-1",
    trigger: { type: "schedule", id: "t", name: "tick-every-minute" },
    data: scheduledAt === null ? {} : { scheduled_at: scheduledAt },
  });

const TRIGGER = { "x-neon-trigger-invocation-id": "inv-1" };

function post(
  path: string,
  init: { headers?: Record<string, string>; body?: string } = {},
) {
  return new Request(`https://tick.example.invalid${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...init.headers },
    body: init.body ?? body(),
  });
}

describe("the tick function", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeEach(async () => {
    pools.length = 0;
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.close();
  });

  function setup(
    opts: { stored?: string; handlers?: Record<string, JobHandler> } = {},
  ) {
    const m = createMemoryDueStore(
      opts.stored === undefined ? {} : { [DUE_KEY]: opts.stored },
    );
    const db = vi.fn(() => t.db);
    const seen: string[] = [];
    const logs: string[] = [];
    const deps: TickHandlerDeps = {
      db,
      store: m.store,
      handlers: () =>
        opts.handlers ?? {
          k: async (job) => {
            seen.push(job.dedupeKey);
          },
        },
      mode: "system",
    };
    return {
      m,
      db,
      seen,
      logs,
      handle: createTickHandler(deps, (line) => logs.push(line)),
    };
  }

  const job = (key: string) =>
    enqueue(t.db, { kind: "k", dedupeKey: key, runAt: T0, payload: {} });

  describe("who may call it", () => {
    it("answers 403 to a request without the trigger header, and touches nothing", async () => {
      const { handle, db, m } = setup({ stored: file(T0.toISOString()) });
      for (const path of ["/", "/safety"]) {
        const res = await handle(post(path));
        expect(res.status).toBe(403);
      }
      const get = await handle(
        new Request("https://tick.example.invalid/", { method: "GET" }),
      );
      expect(get.status).toBe(403);
      expect(db).not.toHaveBeenCalled();
      expect(m.puts).toHaveLength(0);
    });

    it("answers 404 to an unknown path or a non-POST that carries the header", async () => {
      const { handle } = setup();
      expect((await handle(post("/other", { headers: TRIGGER }))).status).toBe(
        404,
      );
      const get = await handle(
        new Request("https://tick.example.invalid/", {
          method: "GET",
          headers: TRIGGER,
        }),
      );
      expect(get.status).toBe(404);
    });

    it("answers 400 when data.scheduled_at is missing or not a time", async () => {
      const { handle, db } = setup();
      for (const b of [body(null), body("not a time"), "not json", ""]) {
        const res = await handle(post("/", { headers: TRIGGER, body: b }));
        expect(res.status).toBe(400);
      }
      expect(db).not.toHaveBeenCalled();
    });
  });

  describe("POST /", () => {
    it("runs tick: a sleeping minute reads the file and opens no database", async () => {
      const { handle, db, logs } = setup({
        stored: file("2026-03-01T10:05:00.000Z"),
      });
      const res = await handle(post("/", { headers: TRIGGER }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        ok: true,
        result: { action: "sleep" },
      });
      expect(db).not.toHaveBeenCalled();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatch(/^tick 2026-03-01T10:00:00\.000Z sleep \d+ms$/);
    });

    it("runs tick: a due minute runs the jobs at the scheduled instant and republishes the file", async () => {
      await job("a");
      await job("b");
      const { handle, seen, m, logs } = setup({
        stored: file(T0.toISOString()),
      });
      const res = await handle(post("/", { headers: TRIGGER }));
      expect(res.status).toBe(200);
      expect(seen.sort()).toEqual(["a", "b"]);
      expect(m.puts).toHaveLength(1);
      expect(JSON.parse(m.objects.get(DUE_KEY)!).next_due_at).toBeNull();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatch(
        /^tick 2026-03-01T10:00:00\.000Z wake ran=2 failed=0 lost=0 next_due_at=none \d+ms$/,
      );
    });

    it("runs at most 20 jobs a tick and leaves the rest due", async () => {
      expect(FUNCTION_TICK_OPTIONS.maxJobs).toBe(20);
      for (let i = 0; i < 25; i++) await job(`burst-${i}`);
      const { handle, seen, m } = setup({ stored: file(T0.toISOString()) });
      await handle(post("/", { headers: TRIGGER }));
      expect(seen).toHaveLength(20);
      expect(JSON.parse(m.objects.get(DUE_KEY)!).next_due_at).toBe(
        T0.toISOString(),
      );
    });

    it("keeps a tick well inside the lease", () => {
      // Handlers have no heartbeat, so a tick that outlives its lease would have
      // its jobs reaped while still running.
      const { leaseMs, maxJobs } = FUNCTION_TICK_OPTIONS;
      expect(leaseMs).toBe(5 * 60_000);
      // 20 jobs leave 15 s each inside the lease.
      expect(leaseMs / maxJobs).toBeGreaterThanOrEqual(15_000);
    });

    it("logs a missing file's republish", async () => {
      await job("a");
      const { handle, logs } = setup();
      await handle(post("/", { headers: TRIGGER }));
      expect(logs.join("\n")).toMatch(/republished missing/);
    });
  });

  describe("POST /safety", () => {
    it("runs safetyTick: rebuilds the due-times file from the job table", async () => {
      await job("a");
      const { handle, m, db, logs } = setup();
      const res = await handle(post("/safety", { headers: TRIGGER }));
      expect(res.status).toBe(200);
      expect(db).toHaveBeenCalledTimes(1);
      expect(JSON.parse(m.objects.get(DUE_KEY)!).next_due_at).toBe(
        T0.toISOString(),
      );
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatch(
        /^safety 2026-03-01T10:00:00\.000Z published next_due_at=2026-03-01T10:00:00\.000Z \d+ms$/,
      );
    });
  });

  describe("failures", () => {
    it("answers 500 with no detail, and logs the error on one line", async () => {
      const { m, logs } = setup({ stored: file(T0.toISOString()) });
      const broken = createTickHandler(
        {
          db: () => {
            throw new Error(
              "connection refused: postgres://user:secret@host/db",
            );
          },
          store: m.store,
          handlers: () => ({}),
          mode: "system",
        },
        (line) => logs.push(line),
      );
      const res = await broken(post("/", { headers: TRIGGER }));
      expect(res.status).toBe(500);
      expect(await res.text()).not.toMatch(/secret|postgres/);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatch(/^tick 2026-03-01T10:00:00\.000Z error: /);
      expect(logs[0]).not.toContain("\n");
    });
  });

  describe("wired from the environment", () => {
    const env = {
      DATABASE_URL: "postgres://user:pw@example.invalid/db",
      AWS_ENDPOINT_URL_S3: "https://storage.example.invalid",
      AWS_REGION: "aws-us-east-1",
      AWS_ACCESS_KEY_ID: "test-key-id",
      AWS_SECRET_ACCESS_KEY: "test-secret",
    };

    it("creates no Pool for a sleeping tick", async () => {
      const m = createMemoryDueStore({
        [DUE_KEY]: file("2026-03-01T10:05:00.000Z"),
      });
      const logs: string[] = [];
      const handle = createTickHandler(
        depsFromEnv(env, { store: m.store }),
        (line) => logs.push(line),
      );
      const res = await handle(post("/", { headers: TRIGGER }));
      expect(res.status).toBe(200);
      expect(pools).toHaveLength(0);
    });

    it("opens the Pool only when the database is asked for, and reuses it", () => {
      const deps = depsFromEnv(env);
      expect(pools).toHaveLength(0);
      deps.db();
      deps.db();
      expect(pools).toHaveLength(1);
    });

    it("refuses to be wired without DATABASE_URL", () => {
      expect(() => depsFromEnv({ ...env, DATABASE_URL: undefined })).toThrow(
        "DATABASE_URL",
      );
    });

    it("reads the clock mode from CLOCK_MODE, defaulting to system", () => {
      expect(depsFromEnv(env).mode).toBe("system");
      expect(depsFromEnv({ ...env, CLOCK_MODE: "replay" }).mode).toBe("replay");
      expect(() => depsFromEnv({ ...env, CLOCK_MODE: "later" })).toThrow(
        "CLOCK_MODE",
      );
    });

    it("builds the due-times store from the injected AWS variables", () => {
      expect(() =>
        depsFromEnv({ ...env, AWS_ENDPOINT_URL_S3: undefined }),
      ).toThrow("AWS_ENDPOINT_URL_S3");
    });

    it("exports a fetch handler as the function's default", () => {
      expect(typeof tickFunction.fetch).toBe("function");
    });
  });
});
