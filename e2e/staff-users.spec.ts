import { expect, test } from "@playwright/test";
import {
  createAccount,
  expectNoSeriousAxeViolations,
  heading,
  hydrated,
  ownAddress,
} from "./helpers/accounts";
import { unlockedAdmin } from "./helpers/staff";

// Users (M8 Task 12): find someone by username and set their trust level by
// hand, which locks it against the nightly job.

test.beforeEach(async ({ page }) => {
  await ownAddress(page);
});

test("find a user, set their trust level with a reason, and it shows locked", async ({
  page,
  request,
}) => {
  await unlockedAdmin(page, request);
  const ada = await createAccount(request);

  await page.goto("/staff/users");
  await expect(heading(page)).toHaveText("Users");
  const search = page.getByRole("search", { name: "Find a user" });
  const find = search.getByRole("button", { name: "Find" });
  await hydrated(find);
  // An address finds nobody.
  await search.getByLabel("Username starts with").fill(ada.email);
  await find.click();
  await expect(page.getByText(/Nobody's username starts with/)).toBeVisible();

  await search
    .getByLabel("Username starts with")
    .fill(ada.username.slice(0, -1));
  await find.click();
  const row = page
    .locator('[data-slot="user-row"]')
    .filter({ hasText: ada.username });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("New");
  await row.getByRole("link", { name: ada.username }).click();

  const panel = page.locator('[data-slot="user-panel"]');
  await expect(panel.getByRole("heading", { level: 2 })).toHaveText(
    ada.username,
  );
  await expect(panel.locator('[data-slot="user-trust"]')).toHaveText(
    "Trust: New · set by the nightly job",
  );
  await expect(panel.getByRole("group", { name: "ACCOUNT" })).toBeVisible();
  await expectNoSeriousAxeViolations(page);

  const trust = panel.getByRole("group", { name: "TRUST" });
  const save = trust.getByRole("button", { name: "Set trust level" });
  await hydrated(save);
  await trust.getByLabel("Trust level").selectOption({ label: "Member" });
  // A reason is required.
  await save.click();
  await expect(panel).toContainText("Give a reason");
  await panel
    .getByLabel("Reason (saved in the audit log)")
    .fill("Long-standing helpful member");
  await save.click();
  await expect(panel.getByRole("status")).toHaveText("Set trust level: done.");
  await expect(panel.locator('[data-slot="user-trust"]')).toHaveText(
    "Trust: Member · locked (the nightly job leaves it)",
  );
  await expect(panel).toContainText("New → Member · by the staff");
  await expect(
    trust.getByRole("button", { name: "Hand back to the nightly job" }),
  ).toBeVisible();
});
