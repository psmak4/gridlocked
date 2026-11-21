import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  neonUsage,
  takeSnapshot,
  vercelCpuHours,
  type SnapshotEnv,
} from "./usage-snapshot";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/usage/${name}`, import.meta.url), "utf8");

const KEY = "test-neon-key-not-real-0123456789";
const TOKEN = "test-vercel-token-not-real-abcdef";
const ENV: SnapshotEnv = {
  NEON_API_KEY: KEY,
  NEON_PROJECT_ID: "example-project-00000000",
  VERCEL_USAGE_TOKEN: TOKEN,
};
const NOW = new Date("2026-03-07T05:00:00Z");

/** Answers Neon and Vercel from the stored fixtures. */
function fakeFetch(over: { neon?: Response; vercel?: Response } = {}) {
  const calls: { url: string; auth: string | null }[] = [];
  const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      auth: new Headers(init?.headers).get("authorization"),
    });
    if (url.startsWith("https://console.neon.tech/")) {
      return over.neon ?? new Response(fixture("neon-project.json"));
    }
    return over.vercel ?? new Response(fixture("vercel-charges.jsonl"));
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

describe("usage-snapshot (M8 Task 14)", () => {
  it("usage-snapshot maps Neon's and Vercel's answers (stored fixtures) to a snapshot, and never prints a key", async () => {
    expect(neonUsage(JSON.parse(fixture("neon-project.json")))).toEqual({
      neonComputeHours: 74,
      neonTransferGb: 1.25,
    });
    // 1800 s and 0.25 h of active CPU; requests aren't CPU.
    expect(vercelCpuHours(fixture("vercel-charges.jsonl"))).toBe(0.75);

    const { fetch, calls } = fakeFetch();
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    const snapshot = await takeSnapshot(ENV, NOW, { fetch, log });
    expect(snapshot).toEqual({
      neonComputeHours: 74,
      neonTransferGb: 1.25,
      vercelCpuHours: 0.75,
    });
    // The month so far, and each key only in its own provider's header.
    expect(calls[0]!.url).toBe(
      "https://console.neon.tech/api/v2/projects/example-project-00000000",
    );
    expect(calls[0]!.auth).toBe(`Bearer ${KEY}`);
    expect(calls[1]!.url).toBe(
      "https://api.vercel.com/v1/billing/charges?from=2026-03-01T00%3A00%3A00.000Z&to=2026-03-07T05%3A00%3A00.000Z",
    );
    expect(calls[1]!.auth).toBe(`Bearer ${TOKEN}`);
    const printed = lines.join("\n");
    expect(printed).not.toContain(KEY);
    expect(printed).not.toContain(TOKEN);
  });

  it("an API error fails the run without the key in the message", async () => {
    const { fetch } = fakeFetch({
      vercel: new Response(`bad token ${TOKEN}`, { status: 403 }),
    });
    const lines: string[] = [];
    const failed = takeSnapshot(ENV, NOW, {
      fetch,
      log: (l) => lines.push(l),
    });
    await expect(failed).rejects.toThrow("Vercel usage: HTTP 403");
    await failed.catch((error: Error) => {
      expect(error.message).not.toContain(TOKEN);
    });
    expect(lines.join("\n")).not.toContain(TOKEN);
  });

  it("a missing token fails the run rather than reading zero", async () => {
    const { fetch, calls } = fakeFetch();
    await expect(
      takeSnapshot({ ...ENV, VERCEL_USAGE_TOKEN: "" }, NOW, {
        fetch,
        log: () => {},
      }),
    ).rejects.toThrow("VERCEL_USAGE_TOKEN is not set");
    expect(calls).toEqual([]);
  });

  it("a Neon answer without the usage fields fails the run", () => {
    expect(() => neonUsage({ project: { id: "x" } })).toThrow(
      "Neon usage: unexpected answer",
    );
  });

  it("no CPU row from Vercel reads as no reading, not zero", () => {
    expect(vercelCpuHours("")).toBeNull();
    expect(
      vercelCpuHours(
        '{"ConsumedQuantity":"10","ConsumedUnit":"Requests","ServiceName":"Edge Requests"}',
      ),
    ).toBeNull();
  });
});
