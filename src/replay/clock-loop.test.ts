import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import { createMemoryDueStore } from "../../tests/helpers/memory-due-store";
import { publishDueTimes } from "@/jobs/due-times";
import { enqueue } from "@/jobs/queue";
import type { JobHandler } from "@/jobs/runner";
import { isSafetyMinute, runReplayClock } from "./clock-loop";

// The replay clock loop (Task 11b): one `tick` per simulated minute, the
// simulated clock written to `settings` first, `safetyTick` at :07 every six
// hours, and a "jump" mode that skips minutes where the tick would only sleep.

const FROM = new Date("2026-03-01T04:00:00.000Z");
const UNTIL = new Date("2026-03-01T13:00:00.000Z");
const at = (iso: string) => new Date(iso);

describe("isSafetyMinute", () => {
  it("is minute 7 of hours 0, 6, 12 and 18 (UTC)", () => {
    expect(isSafetyMinute(at("2026-03-01T06:07:00Z"))).toBe(true);
    expect(isSafetyMinute(at("2026-03-01T00:07:00Z"))).toBe(true);
    expect(isSafetyMinute(at("2026-03-01T18:07:00Z"))).toBe(true);
    expect(isSafetyMinute(at("2026-03-01T06:08:00Z"))).toBe(false);
    expect(isSafetyMinute(at("2026-03-01T07:07:00Z"))).toBe(false);
  });
});

describe("runReplayClock", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  beforeEach(async () => {
    t = await createTestDb();
  });
  afterEach(async () => {
    await t.close();
  });

  /** Two jobs, one of which enqueues a follow-up 20 minutes later. */
  async function run(step: "jump" | "minute") {
    const m = createMemoryDueStore();
    const seen: string[] = [];
    const handler: JobHandler = async (job, ctx) => {
      seen.push(`${job.dedupeKey}@${ctx.clock.now().toISOString()}`);
      if (job.dedupeKey === "a") {
        await enqueue(ctx.db, {
          kind: "k",
          dedupeKey: "a-follow-up",
          runAt: new Date(ctx.clock.now().getTime() + 20 * 60_000),
          payload: {},
        });
      }
    };
    await enqueue(t.db, {
      kind: "k",
      dedupeKey: "a",
      runAt: at("2026-03-01T04:03:30Z"),
      payload: {},
    });
    await enqueue(t.db, {
      kind: "k",
      dedupeKey: "b",
      runAt: at("2026-03-01T09:10:00Z"),
      payload: {},
    });
    await publishDueTimes(t.db, m.store, FROM);

    const stats = await runReplayClock({
      db: t.db,
      deps: {
        db: () => t.db,
        store: m.store,
        handlers: { k: handler },
        mode: "replay",
      },
      from: FROM,
      until: UNTIL,
      step,
    });
    return { stats, seen };
  }

  it("runs each job at the first minute at or after its run_at, and again for what it enqueues", async () => {
    const { seen } = await run("jump");
    expect(seen).toEqual([
      "a@2026-03-01T04:04:00.000Z",
      "a-follow-up@2026-03-01T04:24:00.000Z",
      "b@2026-03-01T09:10:00.000Z",
    ]);
  });

  it("leaves the simulated clock at the end of the window", async () => {
    await run("jump");
    const { rows } = await t.db.execute(
      sql`select value->>'at' as at from settings where key = 'simulated_clock'`,
    );
    expect((rows[0] as { at: string }).at).toBe(UNTIL.toISOString());
  });

  it("jumping gives the same jobs, the same wake count and the same safety ticks as stepping every minute", async () => {
    const jumped = await run("jump");
    await t.close();
    t = await createTestDb();
    const stepped = await run("minute");

    expect(jumped.seen).toEqual(stepped.seen);
    expect(jumped.stats.wakeTicks).toBe(stepped.stats.wakeTicks);
    // 06:07 and 12:07 fall inside the window.
    expect(jumped.stats.safetyTicks).toBe(2);
    expect(stepped.stats.safetyTicks).toBe(2);
    // Stepping visits every minute (04:00 to 13:00 inclusive); jumping does not.
    expect(stepped.stats.ticks).toBe(9 * 60 + 1);
    expect(jumped.stats.ticks).toBeLessThan(20);
  });
});
