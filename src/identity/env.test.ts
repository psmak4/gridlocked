import { describe, expect, it } from "vitest";
import { TEST_AUTH_SECRET } from "../../tests/helpers/auth";
import { ConfigError, parseAuthEnv } from "./env";

const SECRET = TEST_AUTH_SECRET;
const TURNSTILE = "fake-turnstile-secret";

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
      TURNSTILE_SECRET_KEY: TURNSTILE,
    });
    expect(env).toEqual({
      secret: SECRET,
      baseUrl: "https://example.test",
      signUpAllowlist: null,
      discord: null,
      turnstileSecret: TURNSTILE,
      local: false,
    });
  });

  it("needs neither in local mode, and makes up a secret for the run", () => {
    const env = parseAuthEnv({ VITE_LOCAL_DB: "1" });
    expect(env.local).toBe(true);
    expect(env.baseUrl).toBeNull();
    expect(env.secret.length).toBeGreaterThanOrEqual(32);
  });

  it("needs Turnstile's secret outside local mode, and names it, not its value", () => {
    const base = {
      BETTER_AUTH_SECRET: SECRET,
      BETTER_AUTH_URL: "https://a.test",
    };
    expect(() => parseAuthEnv(base)).toThrow(/TURNSTILE_SECRET_KEY/);
    expect(() => parseAuthEnv({ ...base, TURNSTILE_SECRET_KEY: "  " })).toThrow(
      /TURNSTILE_SECRET_KEY/,
    );
  });

  it("leaves Turnstile off in local mode unless a secret is set", () => {
    expect(parseAuthEnv({ VITE_LOCAL_DB: "1" }).turnstileSecret).toBeNull();
    expect(
      parseAuthEnv({ VITE_LOCAL_DB: "1", TURNSTILE_SECRET_KEY: TURNSTILE })
        .turnstileSecret,
    ).toBe(TURNSTILE);
  });

  it("turns Discord on only when both variables are set", () => {
    const local = { VITE_LOCAL_DB: "1" };
    expect(parseAuthEnv(local).discord).toBeNull();
    expect(
      parseAuthEnv({ ...local, DISCORD_CLIENT_ID: "id" }).discord,
    ).toBeNull();
    expect(
      parseAuthEnv({
        ...local,
        DISCORD_CLIENT_ID: "id",
        DISCORD_CLIENT_SECRET: "secret",
      }).discord,
    ).toEqual({ clientId: "id", clientSecret: "secret" });
  });

  it("splits the allowlist, lowercased, and treats blank as open", () => {
    const base = {
      BETTER_AUTH_SECRET: SECRET,
      BETTER_AUTH_URL: "https://a.test",
      TURNSTILE_SECRET_KEY: TURNSTILE,
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

  it("keeps Discord entries beside addresses (M9 Task 1)", () => {
    expect(
      parseAuthEnv({
        BETTER_AUTH_SECRET: SECRET,
        BETTER_AUTH_URL: "https://a.test",
        TURNSTILE_SECRET_KEY: TURNSTILE,
        SIGN_UP_ALLOWED_EMAILS: "owner@x.test, discord:123456789012345678",
      }).signUpAllowlist,
    ).toEqual(["owner@x.test", "discord:123456789012345678"]);
  });

  it("a missing or malformed setting throws ConfigError naming the variable, and its message never contains the value", () => {
    const cases: [Record<string, string>, string, string | null][] = [
      [{}, "BETTER_AUTH_SECRET", null],
      [
        { BETTER_AUTH_SECRET: "short-but-secret-value" },
        "BETTER_AUTH_SECRET",
        "short-but-secret-value",
      ],
      [
        {
          BETTER_AUTH_SECRET: SECRET,
          BETTER_AUTH_URL: "not-a-url-but-private",
        },
        "BETTER_AUTH_URL",
        "not-a-url-but-private",
      ],
      [
        { VITE_LOCAL_DB: "1", BETTER_AUTH_URL: "local-not-a-url-private" },
        "BETTER_AUTH_URL",
        "local-not-a-url-private",
      ],
    ];
    for (const [env, variable, value] of cases) {
      let thrown: unknown;
      try {
        parseAuthEnv(env);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ConfigError);
      const error = thrown as ConfigError;
      expect(error.variable).toBe(variable);
      expect(error.message).toContain(variable);
      if (value) {
        expect(`${error.message} ${error.stack}`).not.toContain(value);
      }
    }
  });
});
