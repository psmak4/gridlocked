import { describe, expect, it, vi } from "vitest";
import { serverFnCsrf, startInstance } from "@/start";

// Ruling 59. The wiring and this app's options; e2e/csrf.spec.ts sends the
// same requests to the built server through Start's real handler.

const SITE = "https://gridlocked.example";

type Server = (ctx: {
  request: Request;
  handlerType: "serverFn" | "router";
  next: () => Promise<unknown>;
}) => Promise<unknown>;

async function run(
  handlerType: "serverFn" | "router",
  headers: Record<string, string>,
) {
  const next = vi.fn(async () => ({ response: new Response("ok") }));
  const server = (serverFnCsrf as unknown as { options: { server: Server } })
    .options.server;
  const result = await server({
    request: new Request(`${SITE}/_serverFn/abc`, { method: "POST", headers }),
    handlerType,
    next,
  });
  return { next, result };
}

describe("the CSRF check on server functions", () => {
  it("is in start.ts's request middleware", async () => {
    const options = await startInstance.getOptions();
    expect(options.requestMiddleware).toContain(serverFnCsrf);
  });

  it("refuses a cross-site server-function request with a 403", async () => {
    for (const headers of <Record<string, string>[]>[
      { "sec-fetch-site": "cross-site", origin: "https://evil.example" },
      { "sec-fetch-site": "same-site" },
      { origin: "https://evil.example" },
      { referer: "https://evil.example/page" },
      // Nothing to tell where it came from.
      {},
    ]) {
      const { next, result } = await run("serverFn", headers);
      expect(next, JSON.stringify(headers)).not.toHaveBeenCalled();
      expect((result as Response).status, JSON.stringify(headers)).toBe(403);
    }
  });

  it("lets a same-origin server-function request through", async () => {
    for (const headers of <Record<string, string>[]>[
      { "sec-fetch-site": "same-origin", origin: SITE },
      { origin: SITE },
      { referer: `${SITE}/settings` },
    ]) {
      const { next } = await run("serverFn", headers);
      expect(next, JSON.stringify(headers)).toHaveBeenCalledOnce();
    }
  });

  it("leaves page requests alone, even from another site", async () => {
    const { next } = await run("router", {
      "sec-fetch-site": "cross-site",
      origin: "https://evil.example",
    });
    expect(next).toHaveBeenCalledOnce();
  });
});
