import { expect, test } from "@playwright/test";
import {
  expectNoSeriousAxeViolations,
  heading,
  hydrated,
} from "../helpers/accounts";
import { FANTASY_ORIGIN, ROUND_1, seedGame } from "../helpers/game";
import { unlockedAdmin } from "../helpers/staff";

// Prices (M8 Task 9) on the seeded 2026 game before round 1 locks: round 2 is
// next and has no prices yet, so the list is round 1's and nothing is
// published. One price is changed by hand, and shows as set by staff. At the
// plan's two sizes.

test.beforeEach(async ({ request }) => {
  await seedGame(request, ROUND_1.beforeLock);
});

for (const size of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
]) {
  test(`change one price by hand, and it shows as set by staff (${size.name})`, async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize(size);
    await unlockedAdmin(page, request, FANTASY_ORIGIN);

    await page.goto("/staff/prices");
    await expect(heading(page)).toHaveText("Prices");
    await expect(page.getByText("PRICES · ROUND 2 · ")).toBeVisible();
    await expect(page.getByText("Not published yet")).toBeVisible();
    await expect(
      page.getByText(/every price carries over from the Australian Grand Prix/),
    ).toBeVisible();
    const table = page.getByRole("table", { name: "Prices" });
    const norris = table
      .locator('[data-slot="price-row"]')
      .filter({ hasText: "Lando Norris" });
    await expect(norris).toContainText("$28.0M");
    await expect(norris).not.toHaveAttribute("data-staff");
    await expectNoSeriousAxeViolations(page);

    const form = page.getByRole("form", { name: "CHANGE ONE BY HAND" });
    await hydrated(form.getByRole("button", { name: "Set price" }));
    const asset = form.getByLabel("Asset");
    const label = await asset
      .locator("option", { hasText: /^Lando Norris/ })
      .textContent();
    await asset.selectOption({ label: label! });
    await form.getByLabel("New price ($M)").fill("27.5");
    await form
      .getByLabel("Reason (saved in the audit log)")
      .fill("Grid penalty announced");
    await form.getByRole("button", { name: "Set price" }).click();
    await expect(
      form.getByText("Lando Norris is $27.5M for the"),
    ).toBeVisible();

    await expect(norris).toHaveAttribute("data-staff", "");
    await expect(norris).toContainText("Set by staff");
    await expect(norris).toContainText("$27.5M");
    await expect(norris).toContainText("▼0.5");
    await expect(page.getByText(/· 1 set by staff/)).toBeVisible();
    await expectNoSeriousAxeViolations(page);

    await page.goto("/staff/audit");
    const log = page.locator("main");
    await expect(log).toContainText("Price set");
    await expect(log).toContainText("Grid penalty announced");
  });
}
