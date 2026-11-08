import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import {
  authPost,
  PASSWORD,
  signUpRequest,
  testAuth,
  type TestAuth,
} from "../../tests/helpers/auth";
import { users } from "@/db/schema";

const SITEVERIFY = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const SECRET = "fake-turnstile-secret-for-tests";

const PROTECTED: [string, Record<string, unknown>][] = [
  [
    "/sign-up/email",
    { email: "a@example.test", password: PASSWORD, name: "A" },
  ],
  ["/sign-in/email", { email: "a@example.test", password: PASSWORD }],
  ["/sign-in/magic-link", { email: "a@example.test" }],
  ["/request-password-reset", { email: "a@example.test" }],
  ["/send-verification-email", { email: "a@example.test" }],
  ["/change-email", { newEmail: "b@example.test" }],
];

describe("Turnstile", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let auth: TestAuth;
  let fetchStub: ReturnType<typeof vi.fn<typeof fetch>>;
  const verified = (success: boolean, hostname = "localhost") =>
    fetchStub.mockImplementation(async (input) => {
      expect(String(input)).toBe(SITEVERIFY);
      return Response.json(
        success
          ? { success: true, hostname }
          : { success: false, "error-codes": ["x"] },
      );
    });
  const people = async () =>
    (await t.db.select().from(users)).filter((u) => u.role !== "system");

  beforeEach(async () => {
    t = await createTestDb();
    auth = testAuth(t.db, { env: { turnstileSecret: SECRET } });
    fetchStub = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchStub);
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    await t.close();
  });

  it.each(PROTECTED)("%s is refused with no token", async (path, body) => {
    const response = await auth.handler(authPost(path, body));
    expect(response.status).toBe(400);
    expect(fetchStub).not.toHaveBeenCalled();
    expect(await people()).toHaveLength(0);
  });

  it("a good token passes", async () => {
    verified(true);
    const response = await auth.handler(
      signUpRequest("ada@example.test", {}, { "x-captcha-response": "good" }),
    );
    expect(response.status).toBe(200);
    expect(await people()).toHaveLength(1);
    // Cloudflare was sent the secret and the token, and only to siteverify.
    const [, init] = fetchStub.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toMatchObject({
      secret: SECRET,
      response: "good",
    });
  });

  it("a token earned on another hostname is refused", async () => {
    verified(true, "elsewhere.example");
    const response = await auth.handler(
      signUpRequest("ada@example.test", {}, { "x-captcha-response": "other" }),
    );
    expect(response.status).toBe(403);
    expect(await people()).toHaveLength(0);
  });

  it("a bad one is refused", async () => {
    verified(false);
    const response = await auth.handler(
      signUpRequest("ada@example.test", {}, { "x-captcha-response": "bad" }),
    );
    expect(response.status).toBe(403);
    expect(await people()).toHaveLength(0);
  });

  it("a verify that hangs fails closed", async () => {
    // A siteverify that never answers, until the plugin's own 10 s deadline
    // aborts the request.
    fetchStub.mockImplementation(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = auth.handler(
      signUpRequest("ada@example.test", {}, { "x-captcha-response": "slow" }),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    const response = await pending;
    vi.useRealTimers();

    expect(response.status).toBe(500);
    expect(response.headers.getSetCookie()).toHaveLength(0);
    expect(await people()).toHaveLength(0);
  });

  it("is off when there is no secret", async () => {
    const open = testAuth(t.db);
    const response = await open.handler(signUpRequest("ada@example.test"));
    expect(response.status).toBe(200);
  });
});
