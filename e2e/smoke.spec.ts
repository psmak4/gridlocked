import { expect, test, type Page } from "@playwright/test";

const FOOTER_COPY =
  "Unofficial. Not affiliated with Formula 1 or the FIA. Data from Jolpica and OpenF1.";

const THEME_KEY = "gridlocked-theme";

const bodyBackground = (page: Page) =>
  page.evaluate(() => getComputedStyle(document.body).backgroundColor);

test.describe("content", () => {
  test("shows the heading, tagline and exact footer copy", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("h1")).toHaveText("GRIDLOCKED");
    await expect(page.getByText("Coming for the 2027 season.")).toBeVisible();
    await expect(page.locator("footer")).toBeVisible();
    await expect(page.locator("footer")).toHaveText(FOOTER_COPY);
  });
});

test.describe("dark device preference", () => {
  test.use({ colorScheme: "dark" });

  test("body background is the dark surface", async ({ page }) => {
    await page.goto("/");
    expect(await bodyBackground(page)).toBe("rgb(11, 11, 30)");
  });
});

test.describe("light device preference", () => {
  test.use({ colorScheme: "light" });

  test("body background is the light surface", async ({ page }) => {
    await page.goto("/");
    expect(await bodyBackground(page)).toBe("rgb(255, 255, 255)");
  });

  test("html has no data-theme when nothing was chosen (negative control)", async ({
    page,
  }) => {
    await page.route("**/assets/**", (route) => route.abort());
    await page.goto("/");
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.*/);
  });

  test("stored dark choice is on <html> before any client bundle runs", async ({
    page,
  }) => {
    await page.addInitScript(
      (key) => localStorage.setItem(key, "dark"),
      THEME_KEY,
    );
    // Block every client bundle: only server HTML and the inline script run.
    await page.route("**/assets/**", (route) => route.abort());
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });
});
