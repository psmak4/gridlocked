import { describe, expect, it } from "vitest";
import type { AnyRouter } from "@tanstack/react-router";
import { reportClientError, startClientReporting } from "./report-client";

// M9 Task 10: the browser loads Sentry only with a DSN, and every event goes
// through the scrubber with the route's pattern, never its address.

type Init = {
  dsn: string;
  release?: string;
  beforeSend: (
    event: Record<string, unknown>,
  ) => Record<string, unknown> | null;
  dataCollection: Record<string, unknown>;
};

function fakeSdk() {
  const calls: { init?: Init; captured: unknown[] } = { captured: [] };
  const sdk = {
    init: (options: Init) => {
      calls.init = options;
    },
    captureException: (error: unknown) => {
      calls.captured.push(error);
    },
  };
  return { calls, load: async () => sdk as never };
}

const router = {
  state: { matches: [{ routeId: "__root__" }, { routeId: "/u/$username" }] },
} as unknown as AnyRouter;

describe("startClientReporting", () => {
  it("loads nothing without a DSN", async () => {
    const { calls, load } = fakeSdk();
    await startClientReporting(router, { dsn: undefined, load });
    expect(calls.init).toBeUndefined();
    reportClientError(new Error("x"));
    expect(calls.captured).toEqual([]);
  });

  it("with a DSN, starts the SDK collecting nothing, and scrubs each event under the route's pattern", async () => {
    const { calls, load } = fakeSdk();
    await startClientReporting(router, {
      dsn: "https://k@o1.ingest.us.sentry.io/2",
      release: "abc123",
      load,
    });
    expect(calls.init).toMatchObject({
      dsn: "https://k@o1.ingest.us.sentry.io/2",
      release: "abc123",
      dataCollection: { userInfo: false, cookies: false, httpBodies: [] },
    });
    const sent = calls.init!.beforeSend({
      exception: { values: [{ type: "TypeError", value: "ada_l's post" }] },
      request: { url: "https://example.test/u/ada_l" },
      user: { username: "ada_l" },
    });
    expect(JSON.stringify(sent)).not.toContain("ada_l");
    expect(sent).toMatchObject({
      tags: { route: "/u/$username" },
      exception: { values: [{ type: "TypeError" }] },
    });

    const caught = new Error("boundary");
    reportClientError(caught);
    expect(calls.captured).toEqual([caught]);
  });
});
