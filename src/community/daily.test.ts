import { describe, expect, it } from "vitest";
import { createCommunityDailyHandler } from "./daily";

const ctx = {
  db: {},
  clock: { now: () => new Date("2026-07-08T06:00:00Z") },
} as never;
const job = { id: "j1", kind: "community_daily", payload: {} } as never;

describe("the community daily job", () => {
  it("logs each step's count", async () => {
    const lines: string[] = [];
    await createCommunityDailyHandler({
      log: (line) => lines.push(line),
      steps: { archiveChats: async () => "archived=2" },
    })(job, ctx);
    expect(lines).toEqual(["community_daily: archiveChats archived=2"]);
  });

  it("a failing step fails the job for the runner's retry, with no message logged", async () => {
    const lines: string[] = [];
    const handler = createCommunityDailyHandler({
      log: (line) => lines.push(line),
      steps: {
        archiveChats: async () => {
          throw new TypeError("fan@example.com broke it");
        },
      },
    });
    await expect(handler(job, ctx)).rejects.toThrow(
      "community_daily: archiveChats failed",
    );
    expect(lines).toEqual(["community_daily: archiveChats failed (TypeError)"]);
  });
});
