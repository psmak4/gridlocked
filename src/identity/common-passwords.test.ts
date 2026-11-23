import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb } from "../../tests/helpers/test-db";
import {
  authPost,
  cookieHeader,
  linkIn,
  PASSWORD,
  recordingSender,
  signUpRequest,
  testAuth,
  type TestAuth,
} from "../../tests/helpers/auth";
import { isCommonPassword, PASSWORD_TOO_COMMON } from "./common-passwords";

// ASVS 5.0 6.2.4 (M9 Task 9): a new password isn't one of the commonest.

describe("isCommonPassword", () => {
  it("knows the list's passwords, whatever their case", () => {
    expect(isCommonPassword("1234567890")).toBe(true);
    expect(isCommonPassword("qwertyuiop")).toBe(true);
    expect(isCommonPassword("QwertyUIOP")).toBe(true);
  });

  it("passes a password that isn't on it", () => {
    expect(isCommonPassword(PASSWORD)).toBe(false);
    expect(isCommonPassword("a brand new password")).toBe(false);
  });

  it("is built from at least the 3,000 commonest passwords that are long enough", () => {
    const list = readFileSync(
      new URL("./common-passwords.txt", import.meta.url),
      "utf8",
    )
      .split("\n")
      .filter(Boolean);
    expect(list.length).toBeGreaterThan(3_000);
    for (const word of list) {
      expect(word.length).toBeGreaterThanOrEqual(10);
      expect(word).toBe(word.toLowerCase());
    }
  });
});

describe("Better Auth refuses a common password", () => {
  let t: Awaited<ReturnType<typeof createTestDb>>;
  let auth: TestAuth;
  let mail: ReturnType<typeof recordingSender>;
  const EMAIL = "ada@example.test";
  const FROM_IP = { "x-forwarded-for": "203.0.113.30" };

  beforeEach(async () => {
    t = await createTestDb();
    mail = recordingSender();
    auth = testAuth(t.db, { sender: mail.sender });
  });
  afterEach(async () => {
    await t.close();
  });

  const refusal = async (response: Response) => ({
    status: response.status,
    code: ((await response.json()) as { code?: string }).code,
  });

  it("at sign-up", async () => {
    const response = await auth.handler(
      signUpRequest(EMAIL, { password: "Password123" }),
    );
    expect(await refusal(response)).toEqual({
      status: 400,
      code: PASSWORD_TOO_COMMON,
    });
  });

  it("when a password is changed", async () => {
    const signUp = await auth.handler(signUpRequest(EMAIL));
    const response = await auth.handler(
      authPost(
        "/change-password",
        { currentPassword: PASSWORD, newPassword: "1q2w3e4r5t" },
        { cookie: cookieHeader(signUp) },
      ),
    );
    expect(await refusal(response)).toEqual({
      status: 400,
      code: PASSWORD_TOO_COMMON,
    });
  });

  it("when a password is reset", async () => {
    await auth.handler(signUpRequest(EMAIL));
    await auth.handler(
      authPost("/request-password-reset", { email: EMAIL }, FROM_IP),
    );
    const token = new URL(linkIn(mail.last(EMAIL, "Reset your"))).pathname
      .split("/")
      .pop()!;
    const response = await auth.handler(
      authPost("/reset-password", { newPassword: "basketball", token }),
    );
    expect(await refusal(response)).toEqual({
      status: 400,
      code: PASSWORD_TOO_COMMON,
    });
  });
});
