import { describe, expect, it } from "vitest";
import { TEST_AUTH_SECRET } from "../../tests/helpers/auth";
import { parseAuthEnv } from "./env";

const SECRET = TEST_AUTH_SECRET;

describe("parseAuthEnv", () => {
  it("needs a secret and a URL outside local mode", () => {
    expect(() => parseAuthEnv({})).toThrow(/BETTER_AUTH_SECRET/);
    expect(() => parseAuthEnv({ BETTER_AUTH_SECRET: SECRET })).toThrow(
      /BETTER_AUTH_URL/,
    );
  });

  it("refuses a short secret and a URL that isn't one", () => {
    expect(() =>
      parseAuthEnv({
        BETTER_AUTH_SECRET: "short",
        BETTER_AUTH_URL: "https://example.test",
      }),
    ).toThrow(/BETTER_AUTH_SECRET/);
    expect(() =>
      parseAuthEnv({ BETTER_AUTH_SECRET: SECRET, BETTER_AUTH_URL: "nope" }),
    ).toThrow(/BETTER_AUTH_URL/);
  });

  it("reads the secret, the URL and no allowlist", () => {
    const env = parseAuthEnv({
      BETTER_AUTH_SECRET: SECRET,
      BETTER_AUTH_URL: "https://example.test",
    });
    expect(env).toEqual({
      secret: SECRET,
      baseUrl: "https://example.test",
      signUpAllowlist: null,
      local: false,
    });
  });

  it("needs neither in local mode, and makes up a secret for the run", () => {
    const env = parseAuthEnv({ VITE_LOCAL_DB: "1" });
    expect(env.local).toBe(true);
    expect(env.baseUrl).toBeNull();
    expect(env.secret.length).toBeGreaterThanOrEqual(32);
  });

  it("splits the allowlist, lowercased, and treats blank as open", () => {
    const base = {
      BETTER_AUTH_SECRET: SECRET,
      BETTER_AUTH_URL: "https://a.test",
    };
    expect(
      parseAuthEnv({
        ...base,
        SIGN_UP_ALLOWED_EMAILS: " A@x.test, b@y.test ,,",
      }).signUpAllowlist,
    ).toEqual(["a@x.test", "b@y.test"]);
    expect(
      parseAuthEnv({ ...base, SIGN_UP_ALLOWED_EMAILS: "  " }).signUpAllowlist,
    ).toBeNull();
  });
});
