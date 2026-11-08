import { expect, test } from "@playwright/test";

// Runs against the VITE_LOCAL_DB=1 build: the memory email sender and the
// test-only route that lists what it took.

const ORIGIN = "http://localhost:3100";
const FORWARDED = { "x-forwarded-for": "203.0.113.31" };

test("a sign-up's verification email shows up on the test route, and its link works", async ({
  request,
}) => {
  const email = `e2e-${crypto.randomUUID()}@example.test`;
  const signUp = await request.post("/api/auth/sign-up/email", {
    headers: { origin: ORIGIN, ...FORWARDED },
    data: { email, password: "correct horse battery", name: "E2E Person" },
  });
  expect(signUp.status()).toBe(200);

  const listed = await request.get(
    `/api/test/emails?to=${encodeURIComponent(email)}`,
  );
  expect(listed.status()).toBe(200);
  expect(listed.headers()["cache-control"]).toBe("private, no-store");
  const { emails } = (await listed.json()) as {
    emails: { to: string; subject: string; text: string }[];
  };
  expect(emails).toHaveLength(1);
  expect(emails[0]!.subject).toContain("Confirm your email");

  const link = emails[0]!.text.match(/https?:\/\/\S+/)![0];
  const verified = await request.get(link, { maxRedirects: 0 });
  expect(verified.status()).toBe(302);
  expect(verified.headers()["cache-control"]).toBe("private, no-store");
});
