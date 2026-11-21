import { expect, test } from "@playwright/test";
import {
  createAccount,
  expectNoSeriousAxeViolations,
  heading,
  ownAddress,
} from "./helpers/accounts";
import { runStaffCommand, unlockedAdmin } from "./helpers/staff";

test.beforeEach(async ({ page }) => {
  await ownAddress(page);
});

for (const size of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
]) {
  test(`the audit log lists a staff change with its reason, and has no edit control (${size.name})`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize(size);
    const admin = await unlockedAdmin(page, request);
    const ada = await createAccount(request);
    await runStaffCommand(
      request,
      "set-role",
      { username: ada.username, role: "moderator" },
      "Helping with the forum",
    );

    await page.goto("/staff/audit");
    await expect(heading(page)).toHaveText("Audit log");
    await expect(
      page.getByText(
        "Every staff change and security event. Nothing here can be edited or deleted. Emails and IP addresses are never stored.",
      ),
    ).toBeVisible();

    // The role change, by the workflow, with what changed and why. Other
    // specs share this database, so rows are picked by this run's names.
    const row = page
      .getByRole("row")
      .filter({ hasText: "Role change" })
      .filter({ hasText: ada.username });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("e2e-workflow");
    await expect(row).toContainText(ada.username);
    await expect(row).toContainText("role: user → moderator");
    await expect(row).toContainText("Helping with the forum");
    // The admin's own unlock is there too, as a security event.
    await expect(
      page
        .getByRole("row")
        .filter({ hasText: "Staff tools unlocked" })
        .filter({ hasText: admin.username }),
    ).toHaveCount(1);

    // Filtered to moderation, it isn't there.
    await page.getByLabel("What").selectOption("moderation");
    await page.getByRole("button", { name: "Show" }).click();
    await expect(page).toHaveURL(/group=moderation/);
    await expect(heading(page)).toHaveText("Audit log");
    await expect(
      page.getByRole("row").filter({ hasText: ada.username }),
    ).toHaveCount(0);

    // Read-only: the filter's Show is the only button on the page.
    const main = page.getByRole("main");
    await expect(main.getByRole("button")).toHaveCount(1);
    await expect(main.getByRole("textbox")).toHaveCount(0);
    await expectNoSeriousAxeViolations(page);
  });
}
