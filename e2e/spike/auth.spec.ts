import { expect, test } from "@playwright/test";

/**
 * Spike (Task 4): needs a server built with VITE_SPIKE_LOCAL=1 (seeded PGlite)
 * and BETTER_AUTH_SECRET set. Run on its own: `playwright test e2e/spike`.
 */
test("sign up, sign out, sign in, pick, and /me redirects once signed out", async ({
  page,
}) => {
  const email = `spike-${crypto.randomUUID()}@example.test`;
  const password = "spike-password-1";

  await page.goto("/me");
  await expect(page).toHaveURL(/\/sign-in$/);

  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign up" }).click();
  await expect(page).toHaveURL(/\/me$/);
  await expect(page.getByTestId("email")).toHaveText(email);
  await expect(page.getByTestId("role")).toHaveText("Member");

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);

  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/me$/);
  await expect(page.getByTestId("email")).toHaveText(email);

  await page.goto("/picks");
  const first = page.getByRole("list").getByRole("button").first();
  await first.click();
  await expect(first).toHaveAttribute("aria-pressed", "true");
  // The pick survives a reload: it was saved for this user.
  await page.reload();
  await expect(
    page.getByRole("list").getByRole("button").first(),
  ).toHaveAttribute("aria-pressed", "true");

  await page.goto("/me");
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await page.goto("/me");
  await expect(page).toHaveURL(/\/sign-in$/);
});
