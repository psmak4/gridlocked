import { expect, test } from "@playwright/test";
import {
  expectNoSeriousAxeViolations,
  heading,
  hydrated,
} from "../helpers/accounts";
import { FANTASY_ORIGIN, moveClock, ROUND_1, seedGame } from "../helpers/game";
import { unlockedAdmin } from "../helpers/staff";

// Session results and corrections (M8 Task 7) on the seeded 2026 game, with
// round 1's qualifying in: a correction to Norris is saved, shows on his row
// and under "What changed", then is revoked. At the plan's two sizes.

test.beforeEach(async ({ request }) => {
  await seedGame(request, ROUND_1.beforeLock);
  await moveClock(request, ROUND_1.afterQualifying);
});

for (const size of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
]) {
  test(`add a correction, see it marked, then revoke it (${size.name})`, async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize(size);
    await unlockedAdmin(page, request, FANTASY_ORIGIN);

    // From the calendar's event panel.
    await page.goto("/staff/calendar");
    await page.getByRole("link", { name: /^Australian Grand Prix/ }).click();
    const panel = page.getByRole("region", { name: "Australian Grand Prix" });
    await panel.getByRole("link", { name: "Results of Qualifying" }).click();
    await expect(page).toHaveURL(/\/staff\/results\/[0-9a-f-]{36}$/);
    await expect(heading(page)).toHaveText(
      "Australian Grand Prix · Qualifying",
    );
    await expect(page.getByText("RESULTS · ROUND 1")).toBeVisible();
    await expect(page.getByText(/^From Jolpica · last checked /)).toBeVisible();
    // The replay enters the drivers Jolpica leaves out of qualifying.
    const source = page.getByText(/^From Jolpica · /);
    const count = async () =>
      Number(
        /· (\d+|no) admin corrections?$/
          .exec((await source.textContent()) ?? "")?.[1]
          ?.replace("no", "0"),
      );
    const before = await count();
    expect(before).toBeGreaterThanOrEqual(0);
    await expect(
      page.getByRole("button", { name: "Check provider again" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /Reopen/ })).toHaveCount(0);

    const table = page.getByRole("table", { name: "Results" });
    const norris = table
      .locator('[data-slot="result-row"]')
      .filter({ hasText: "Norris" });
    await expect(norris).toHaveCount(1);
    await expect(norris).not.toHaveAttribute("data-overridden");
    await expectNoSeriousAxeViolations(page);

    // Add a correction.
    const form = page.getByRole("form", { name: "ADD A CORRECTION" });
    await hydrated(form.getByRole("button", { name: "Save correction" }));
    const driver = form.getByLabel("Driver");
    const label = await driver
      .locator("option", { hasText: /^Norris/ })
      .textContent();
    await driver.selectOption({ label: label! });
    await expect(
      form.getByText(
        /^Saving re-scores this session\. \d+ teams? owns? Norris or /,
      ),
    ).toBeVisible();
    await form.getByLabel("What to change").selectOption("Finishing position");
    await form.getByLabel("New value").fill("12");
    await form
      .getByLabel("Reason (players see this)")
      .fill("Lap time deleted for track limits");
    await form.getByRole("button", { name: "Save correction" }).click();
    await expect(
      form.getByText("Correction saved. The session is being re-scored."),
    ).toBeVisible();

    await expect(norris).toHaveAttribute("data-overridden", "");
    await expect(norris).toContainText("Corrected");
    await expect(norris).toContainText("12");
    await expect.poll(count).toBe(before + 1);
    const changes = page.getByRole("list", { name: "What changed" });
    const correction = changes
      .locator('[data-slot="result-correction"]')
      .filter({ hasText: "Norris: P12" });
    await expect(correction).toContainText(
      "“Lap time deleted for track limits”",
    );
    await expectNoSeriousAxeViolations(page);

    // Revoke it.
    await correction
      .getByRole("button", { name: "Revoke the correction to Norris" })
      .click();
    const revoke = page.getByRole("form", {
      name: "Revoke the correction to Norris",
    });
    await revoke
      .getByLabel("Reason (players see this)")
      .fill("The stewards reinstated the lap");
    await revoke.getByRole("button", { name: "Revoke correction" }).click();

    await expect(norris).not.toHaveAttribute("data-overridden");
    await expect(correction).toContainText("· revoked ");
    await expect.poll(count).toBe(before);
  });
}
