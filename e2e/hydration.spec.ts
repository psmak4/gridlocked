import { expect, test } from "@playwright/test";

test.describe("hydration", () => {
  test("a server-rendered Button is disabled when the client bundle is blocked", async ({
    page,
  }) => {
    await page.route("**/assets/**", (route) => route.abort());
    await page.goto("/components");
    await expect(
      page.getByRole("button", { name: "Save team" }),
    ).toBeDisabled();
    // A static link is a plain link, usable without the client.
    await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  });

  test("it is enabled once the client has loaded", async ({ page }) => {
    await page.goto("/components");
    await expect(page.getByRole("button", { name: "Save team" })).toBeEnabled();
  });

  test("the Toast goes away by itself after 4 seconds", async ({ page }) => {
    await page.goto("/components");
    const toast = page.getByRole("status").filter({ hasText: "Team saved" });
    await expect(toast).toBeVisible();
    await expect(toast).toBeHidden({ timeout: 8000 });
  });
});
