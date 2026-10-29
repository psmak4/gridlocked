import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import type { TickDb } from "@/jobs/tick";
import type { Db } from "@/db/types";
import type { ClockDb } from "@/lib/resolve-clock";

// The real Pool opens a WebSocket on first use; here its constructor is a stub
// that records what it was given.
const pools: Array<{
  config: { connectionString: string };
  end: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}> = [];

vi.mock("@neondatabase/serverless", () => ({
  Pool: class {
    end = vi.fn(async () => {});
    on = vi.fn();
    constructor(readonly config: { connectionString: string }) {
      pools.push(this);
    }
  },
}));

import { createDb } from "./client";

beforeEach(() => {
  pools.length = 0;
});

describe("createDb", () => {
  it("creates no Pool until db() is called", () => {
    const handle = createDb("postgres://user:pw@example.invalid/db");
    expect(pools).toHaveLength(0);
    handle.db();
    expect(pools).toHaveLength(1);
  });

  it("gives the connection string to the Pool and reuses one Pool for every call", () => {
    const handle = createDb("postgres://user:pw@example.invalid/db");
    const first = handle.db();
    const second = handle.db();
    expect(second).toBe(first);
    expect(pools).toHaveLength(1);
    expect(pools[0]!.config.connectionString).toBe(
      "postgres://user:pw@example.invalid/db",
    );
  });

  it("listens for Pool errors, so an idle connection that drops does not crash the process", () => {
    createDb("postgres://u:p@example.invalid/db").db();
    expect(pools[0]!.on).toHaveBeenCalledWith("error", expect.any(Function));
  });

  it("close() ends the Pool it opened, and does nothing when none was opened", async () => {
    const unused = createDb("postgres://u:p@example.invalid/db");
    await unused.close();
    expect(pools).toHaveLength(0);

    const used = createDb("postgres://u:p@example.invalid/db");
    used.db();
    await used.close();
    expect(pools[0]!.end).toHaveBeenCalledTimes(1);
  });

  it("opens a new Pool after close()", async () => {
    const handle = createDb("postgres://u:p@example.invalid/db");
    handle.db();
    await handle.close();
    handle.db();
    expect(pools).toHaveLength(2);
  });

  it("returns a database the tick, the domain code and resolveClock accept", () => {
    const handle = createDb("postgres://u:p@example.invalid/db");
    expectTypeOf(handle.db).returns.toMatchTypeOf<Db & ClockDb>();
    expectTypeOf(handle.db).returns.toMatchTypeOf<TickDb>();
  });
});
