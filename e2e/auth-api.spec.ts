import { expect, test } from "@playwright/test";

// Runs against a build made with VITE_LOCAL_DB=1: the auth route uses an
// in-memory PGlite and a secret made up for the run.

const ORIGIN = "http://localhost:3100";
// Better Auth keys its rate limit on the client IP.
const FORWARDED = { "x-forwarded-for": "203.0.113.7" };

test.describe("logged-out pages", () => {
  test("a logged-out home page sets no cookie and stays cacheable", async ({
    request,
  }) => {
    const response = await request.get("/");
    expect(response.status()).toBe(200);
    expect(response.headers()["set-cookie"]).toBeUndefined();
    expect(response.headers()["cache-control"] ?? "").not.toMatch(
      /no-store|private/,
    );
  });
});

test.describe("/api/auth", () => {
  test("the auth route answers private, no-store", async ({ request }) => {
    const ok = await request.get("/api/auth/ok", { headers: FORWARDED });
    expect(ok.status()).toBe(200);
    expect(ok.headers()["cache-control"]).toBe("private, no-store");

    const missing = await request.get("/api/auth/no-such-path", {
      headers: FORWARDED,
    });
    expect(missing.status()).toBe(404);
    expect(missing.headers()["cache-control"]).toBe("private, no-store");

    const wrong = await request.post("/api/auth/sign-in/email", {
      headers: { origin: ORIGIN, ...FORWARDED },
      data: { email: "nobody@example.test", password: "not a password" },
    });
    expect(wrong.status()).toBe(401);
    expect(wrong.headers()["cache-control"]).toBe("private, no-store");
  });

  test("sign-up sets a Secure session cookie, and says no-store", async ({
    request,
  }) => {
    const response = await request.post("/api/auth/sign-up/email", {
      headers: { origin: ORIGIN, ...FORWARDED },
      data: {
        email: `e2e-${crypto.randomUUID()}@example.test`,
        password: "correct horse battery",
        name: "E2E Person",
        ageConfirmed: true,
        accepted: true,
      },
    });
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toBe("private, no-store");
    expect(response.headers()["set-cookie"]).toMatch(
      /__Secure-better-auth\.session_token=.*Secure/i,
    );
  });
});
