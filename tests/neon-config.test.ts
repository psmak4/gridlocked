import { afterEach, describe, expect, it, vi } from "vitest";

// neon.ts declares the function's variables from the deploy's environment.
async function functionEnv(env: Record<string, string>) {
  for (const name of [
    "CLOCK_MODE",
    "RESEND_API_KEY",
    "EMAIL_FROM",
    "VAPID_PUBLIC_KEY",
    "VAPID_PRIVATE_KEY",
    "SENTRY_DSN",
  ]) {
    vi.stubEnv(name, env[name] ?? "");
  }
  vi.resetModules();
  const { default: config } = await import("../neon");
  return (config as { functions: { tick: { env?: unknown } } }).functions.tick
    .env;
}

describe("neon.ts", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("passes CLOCK_MODE=replay to the tick on a beta deploy (M9 Task 13)", async () => {
    expect(await functionEnv({ CLOCK_MODE: "replay" })).toEqual({
      CLOCK_MODE: "replay",
    });
    expect(
      await functionEnv({
        CLOCK_MODE: "replay",
        SENTRY_DSN: "https://key@example.test/1",
      }),
    ).toMatchObject({ CLOCK_MODE: "replay", SENTRY_DSN: expect.any(String) });
  });

  it("declares no clock mode on a real-clock deploy, where the default is system", async () => {
    expect(await functionEnv({ CLOCK_MODE: "system" })).toBeUndefined();
    expect(await functionEnv({})).toBeUndefined();
  });
});
