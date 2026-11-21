import { expect, test, type Locator } from "@playwright/test";
import {
  expectNoSeriousAxeViolations,
  heading,
  hydrated,
} from "../helpers/accounts";
import { FANTASY_ORIGIN, ROUND_1, seedGame } from "../helpers/game";
import { unlockedAdmin } from "../helpers/staff";

// Drivers and seats (M8 Task 6) on the seeded 2026 game, before round 1
// locks: Bearman moves from Haas to Audi from round 3, and the table shows
// the closed Haas seat and the open Audi one. At the plan's two sizes.

test.beforeEach(async ({ request }) => {
  await seedGame(request, ROUND_1.beforeLock);
});

/** The value of the first option of `select` whose text matches. */
const optionValue = async (select: Locator, text: RegExp) =>
  (await select
    .locator("option", { hasText: text })
    .first()
    .getAttribute("value"))!;

for (const size of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
]) {
  test(`move a driver from a date, and the table shows the closed seat and the new one (${size.name})`, async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize(size);
    await unlockedAdmin(page, request, FANTASY_ORIGIN);

    await page.goto("/staff/seats");
    await expect(heading(page)).toHaveText("Drivers and seats");
    const panel = page.getByRole("region", { name: "Australian Grand Prix" });
    await expect(panel.getByText("AVAILABILITY · ROUND 1")).toBeVisible();
    await expect(
      panel.getByText(
        "Shown to players as warnings. Points always come from the results.",
      ),
    ).toBeVisible();

    const open = page.getByRole("button", {
      name: "Move a driver from a date",
    });
    await hydrated(open);
    await open.click();
    const form = page.getByRole("form", { name: "Move a driver from a date" });
    const from = form.getByLabel("From");
    await from.selectOption(await optionValue(from, /^Round 3 · /));
    await form.getByLabel("Driver").selectOption({ label: "Oliver Bearman" });
    const team = form.getByLabel("New team");
    await team.selectOption(await optionValue(team, /Audi/));
    await form.getByLabel("Car number").fill("87");
    await form
      .getByLabel("Reason (saved in the audit log)")
      .fill("Moves to Audi from Japan");
    await form.getByRole("button", { name: "Move driver" }).click();
    await expect(form).toHaveCount(0);

    const seats = page.getByRole("table", { name: "Seats" });
    const bearman = seats.getByRole("row").filter({ hasText: "Bearman" });
    await expect(bearman).toHaveCount(2);
    await expect(bearman.filter({ hasText: "HAA" })).toContainText(/\(rd 2\)$/);
    await expect(bearman.filter({ hasText: /AUD/ })).toContainText(
      /\(rd 3\)\s*Open$/,
    );

    // The Haas tab keeps only Haas's seats.
    await page.getByRole("link", { name: /Haas/ }).click();
    await expect(page).toHaveURL(/team=/);
    await expect(
      page.getByRole("table", { name: "Seats" }).getByText("AUD"),
    ).toHaveCount(0);

    await expectNoSeriousAxeViolations(page);
  });
}
