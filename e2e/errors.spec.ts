import { expect, test } from "@playwright/test";

const FOOTER_COPY =
  "Unofficial. Not affiliated with Formula 1 or the FIA. Data from Jolpica and OpenF1.";

test.describe("unknown URL", () => {
  test("is a 404 that is never cached", async ({ request }) => {
    const response = await request.get("/no-such-page");
    expect(response.status()).toBe(404);
    expect(response.headers()["cache-control"]).toBe("private, no-store");
  });

  test("a missing asset is a 404 that is never cached", async ({ request }) => {
    // Nitro's static handler answers /assets/* before Start's middleware runs,
    // and marked a miss `public, max-age=31536000, immutable`.
    const response = await request.get("/assets/no-such-file.js");
    expect(response.status()).toBe(404);
    expect(response.headers()["cache-control"]).toBe("private, no-store");
  });

  test("shows a real page with the footer", async ({ page }) => {
    await page.goto("/no-such-page");
    await expect(page.locator("h1")).toHaveText("Page not found");
    await expect(page.locator("footer")).toHaveText(FOOTER_COPY);
  });
});
