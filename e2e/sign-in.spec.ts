import { expect, test } from "@playwright/test";
import {
  createAccount,
  emailTo,
  heading,
  hydrated,
  linkIn,
  newEmail,
  ORIGIN,
  ownAddress,
  signInButton,
} from "./helpers/accounts";

test.beforeEach(async ({ page }) => {
  await ownAddress(page);
});

test.describe("sign in", () => {
  test("signs in with an email and password, and signs out", async ({
    page,
    request,
  }) => {
    const { email, username, password } = await createAccount(request);
    await page.goto("/sign-in");
    await expect(heading(page)).toHaveText("Sign in");
    await hydrated(signInButton(page));
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL("/");
    await expect(page.getByText(`Signed in as ${username}`)).toBeVisible();

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByText(`Signed in as ${username}`)).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  });

  test("a wrong password says so plainly", async ({ page, request }) => {
    const { email } = await createAccount(request);
    await page.goto("/sign-in");
    await hydrated(signInButton(page));
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill("not the password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
      page.getByText("That email and password don't match."),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/sign-in$/);
  });

  test("password reset works and the old password stops", async ({
    page,
    request,
  }) => {
    const { email, password } = await createAccount(request);
    const fresh = "a brand new passphrase";

    await page.goto("/sign-in");
    await page.getByRole("link", { name: "Forgot your password?" }).click();
    await expect(heading(page)).toHaveText("Reset your password");
    await hydrated(page.getByRole("button", { name: "Send reset link" }));
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Send reset link" }).click();
    await expect(heading(page)).toHaveText("Check your email");

    const link = linkIn(await emailTo(page.request, email, "Reset your"));
    await page.goto(link);
    await expect(page).toHaveURL(/\/reset-password\?token=/);
    await expect(heading(page)).toHaveText("Choose a new password");
    await hydrated(page.getByRole("button", { name: "Save password" }));
    await page.getByLabel("New password").fill(fresh);
    await page.getByRole("button", { name: "Save password" }).click();
    await expect(page).toHaveURL(/\/sign-in/);
    await expect(
      page.getByText("Password changed. Sign in with the new one."),
    ).toBeVisible();

    // The old one no longer works.
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
      page.getByText("That email and password don't match."),
    ).toBeVisible();

    // The new one does.
    await page.getByLabel("Password").fill(fresh);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).toHaveURL("/");
  });

  test("an expired reset link offers a new one", async ({ page }) => {
    await page.goto("/reset-password?error=INVALID_TOKEN");
    await expect(heading(page)).toHaveText("That link has expired");
    await expect(
      page.getByRole("button", { name: "Send a new reset link" }),
    ).toBeVisible();
  });

  test("a banned user sees a plain message", async ({ page, request }) => {
    const { email, password } = await createAccount(request);
    const banned = await request.post("/api/test/ban", {
      headers: { origin: ORIGIN },
      data: { email, reason: "posting spam links" },
    });
    expect(banned.status()).toBe(200);

    await page.goto("/sign-in");
    await hydrated(signInButton(page));
    await page.getByLabel("Email").fill(email);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByText("This account can't sign in.")).toBeVisible();
    // The reason is not for the person at the keyboard.
    await expect(page.getByText(/spam/)).toHaveCount(0);
    await expect(page).toHaveURL(/\/sign-in$/);
  });

  test("a sign-in link for an unknown address still says to check email", async ({
    page,
  }) => {
    await page.goto("/sign-in?mode=link");
    await hydrated(page.getByRole("button", { name: "Send link" }));
    await page.getByLabel("Email").fill(newEmail());
    await page.getByRole("button", { name: "Send link" }).click();
    await expect(heading(page)).toHaveText("Check your email");
  });

  test("each form works with the keyboard alone", async ({ page, request }) => {
    const { email, password } = await createAccount(request);
    await page.goto("/sign-in");
    await hydrated(signInButton(page));
    await page.getByLabel("Email").focus();
    await page.keyboard.type(email);
    await page.keyboard.press("Tab");
    await page.keyboard.type(password);
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL("/");

    // The reset form.
    await page.context().clearCookies();
    await page.goto("/reset-password");
    await hydrated(page.getByRole("button", { name: "Send reset link" }));
    await page.getByLabel("Email").focus();
    await page.keyboard.type(email);
    await page.keyboard.press("Enter");
    await expect(heading(page)).toHaveText("Check your email");
  });

  test("the sign-in button stays disabled until hydrated", async ({ page }) => {
    await page.route("**/assets/**", (route) => route.abort());
    await page.goto("/sign-in");
    await expect(
      page.getByRole("button", { name: "Sign in", exact: true }),
    ).toBeDisabled();
  });

  test("a banned user sees the same plain message from a sign-in link", async ({
    page,
    request,
  }) => {
    const { email } = await createAccount(request);
    await request.post("/api/test/ban", {
      headers: { origin: ORIGIN },
      data: { email, reason: "posting spam links" },
    });
    await page.goto("/sign-in?mode=link");
    await hydrated(page.getByRole("button", { name: "Send link" }));
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Send link" }).click();
    await expect(heading(page)).toHaveText("Check your email");
    const link = linkIn(await emailTo(page.request, email, "sign-in link"));
    await page.goto(link);
    await expect(page.getByText("This account can't sign in.")).toBeVisible();
    await expect(page.getByText(/spam/)).toHaveCount(0);
  });

  test("a redirect that depends on the session is private, no-store", async ({
    page,
    request,
  }) => {
    // Someone signed in but unfinished is bounced from home to /welcome.
    const email = `e2e-${crypto.randomUUID()}@example.test`;
    await page.goto("/sign-in?mode=link");
    await hydrated(page.getByRole("button", { name: "Send link" }));
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Send link" }).click();
    await expect(heading(page)).toHaveText("Check your email");
    await page.goto(linkIn(await emailTo(page.request, email, "sign-in link")));
    await expect(page).toHaveURL(/\/welcome$/);
    const bounced = await page.request.get("/", { maxRedirects: 0 });
    expect(bounced.status()).toBeGreaterThanOrEqual(300);
    expect(bounced.status()).toBeLessThan(400);
    expect(bounced.headers()["cache-control"]).toBe("private, no-store");
    void request;

    // So is the bounce of a logged-out visitor from a signed-in step.
    const away = await request.get("/welcome/favorites", { maxRedirects: 0 });
    expect(away.status()).toBeGreaterThanOrEqual(300);
    expect(away.status()).toBeLessThan(400);
    expect(away.headers()["cache-control"]).toBe("private, no-store");
  });
});
