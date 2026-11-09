import { createRequire } from "node:module";
import { expect, type APIRequestContext, type Page } from "@playwright/test";

export const ORIGIN = "http://localhost:3100";
export const PASSWORD = "correct horse battery";

const require = createRequire(import.meta.url);

/** A new address and username for each test, so none meets another's. */
export const newEmail = () => `e2e-${crypto.randomUUID()}@example.test`;
export const newUsername = () => `e2e_${crypto.randomUUID().slice(0, 8)}`;

/**
 * Better Auth keys its rate limits on the client address, so every test gets
 * its own, set on each request the page makes.
 */
const randomAddress = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(3));
  return `10.${bytes[0]}.${bytes[1]}.${bytes[2]}`;
};

export async function ownAddress(page: Page) {
  const forwarded = randomAddress();
  await page.context().setExtraHTTPHeaders({ "x-forwarded-for": forwarded });
  return forwarded;
}

type Captured = { to: string; subject: string; text: string };

/** The newest email to `to` whose subject has `subject` in it, once it arrives. */
export async function emailTo(
  request: APIRequestContext,
  to: string,
  subject: string,
): Promise<Captured> {
  let found: Captured | undefined;
  await expect
    .poll(
      async () => {
        const response = await request.get(
          `/api/test/emails?to=${encodeURIComponent(to)}`,
        );
        const { emails } = (await response.json()) as { emails: Captured[] };
        found = emails.filter((e) => e.subject.includes(subject)).at(-1);
        return found !== undefined;
      },
      { message: `an email to ${to} about "${subject}"` },
    )
    .toBe(true);
  return found!;
}

/** The one link in an email. */
export const linkIn = (email: Captured) =>
  email.text.match(/https?:\/\/\S+/)![0];

/** Creates an account straight through the API, as the email form would. */
export async function createAccount(
  request: APIRequestContext,
  input: { email?: string; username?: string; password?: string } = {},
) {
  const email = input.email ?? newEmail();
  const username = input.username ?? newUsername();
  const password = input.password ?? PASSWORD;
  const response = await request.post("/api/auth/sign-up/email", {
    headers: { origin: ORIGIN, "x-forwarded-for": randomAddress() },
    data: {
      email,
      password,
      name: username,
      username,
      ageConfirmed: true,
      accepted: true,
    },
  });
  expect(response.status()).toBe(200);
  return { email, username, password };
}

type AxeResults = {
  violations: { id: string; impact: string | null; help: string }[];
};

/** Runs axe on the page and fails on anything serious or critical. */
export async function expectNoSeriousAxeViolations(page: Page) {
  await page.addScriptTag({ path: require.resolve("axe-core") });
  const results = await page.evaluate(() =>
    (
      window as unknown as { axe: { run: () => Promise<AxeResults> } }
    ).axe.run(),
  );
  const serious = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  expect(
    serious.map((v) => `${v.id}: ${v.help}`),
    "serious axe violations",
  ).toEqual([]);
}

/** The label of the page's main heading. */
export const heading = (page: Page) => page.getByRole("heading", { level: 1 });

/** Signs in through the sign-in form and waits for home. */
export async function signIn(
  page: Page,
  account: { email: string; password: string },
) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page).toHaveURL("/");
}

/**
 * Follows the confirmation email's link, which also signs the browser in
 * (`autoSignInAfterVerification`).
 */
export async function verifyByEmail(page: Page, email: string) {
  const link = linkIn(await emailTo(page.request, email, "Confirm your email"));
  await page.goto(link);
  await expect(page).toHaveURL("/");
}

/**
 * Posts JSON from inside the page, so the browser's own cookies go with it
 * and any it is sent back land in the browser (a local-only test hook that
 * acts as the signed-in person).
 */
export async function postFromPage(
  page: Page,
  path: string,
  body: unknown = {},
): Promise<{ status: number; json: unknown }> {
  return page.evaluate(
    async ({ path, body }) => {
      const response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      let json: unknown = null;
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
      return { status: response.status, json };
    },
    { path, body },
  );
}
