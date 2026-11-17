import { describe, expect, it, vi } from "vitest";
import { LOCAL_TURNSTILE_TOKEN } from "@/components/turnstile";
import { SITEVERIFY_URL, createTurnstileVerifier } from "./turnstile";

describe("the Turnstile check for our own forms", () => {
  it("asks Cloudflare with the secret and the token", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ success: true }),
    );
    const verify = createTurnstileVerifier({
      secret: "test-secret",
      local: false,
      fetch,
    });
    expect(await verify("a-token")).toBe(true);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(SITEVERIFY_URL);
    const sent = init!.body as URLSearchParams;
    expect(sent.get("secret")).toBe("test-secret");
    expect(sent.get("response")).toBe("a-token");
  });

  it("a failed, broken or unreachable check is a no", async () => {
    for (const answer of [
      async () => Response.json({ success: false }),
      async () => new Response("oops", { status: 500 }),
      async () => {
        throw new Error("offline");
      },
    ]) {
      const verify = createTurnstileVerifier({
        secret: "test-secret",
        local: false,
        fetch: vi.fn<typeof globalThis.fetch>(answer),
      });
      expect(await verify("a-token")).toBe(false);
    }
  });

  it("a local build with no secret takes only the stand-in's token", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const verify = createTurnstileVerifier({ secret: null, local: true, fetch });
    expect(await verify(LOCAL_TURNSTILE_TOKEN)).toBe(true);
    expect(await verify("anything-else")).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("a deployed host with no secret refuses everything", async () => {
    const verify = createTurnstileVerifier({
      secret: null,
      local: false,
      fetch: vi.fn<typeof globalThis.fetch>(),
    });
    expect(await verify(LOCAL_TURNSTILE_TOKEN)).toBe(false);
  });
});
