import { expect, test } from "@playwright/test";
import {
  createAccount,
  expectNoSeriousAxeViolations,
  heading,
  hydrated,
  ownAddress,
  signIn,
} from "./helpers/accounts";
import { makeAdmin, setUpTotp } from "./helpers/staff";

test.beforeEach(async ({ page }) => {
  await ownAddress(page);
});

test.describe("the staff area", () => {
  test("a locked staff session is sent to the security page", async ({
    page,
    request,
  }) => {
    const account = await createAccount(request);
    await makeAdmin(request, account.email);
    await signIn(page, account);

    // No two-step sign-in yet: set it up first.
    await page.goto("/staff");
    await expect(page).toHaveURL("/settings/security");
    await expect(heading(page)).toHaveText("Password and security");

    // On, but not unlocked this session: still locked.
    const { backupCodes } = await setUpTotp(page, account.password);
    await page.goto("/staff");
    await expect(page).toHaveURL("/settings/security");

    // Unlocked, the staff area opens from the profile's link.
    const section = page.getByRole("region", { name: "Two-step sign-in" });
    await hydrated(section.getByRole("button", { name: "Unlock staff tools" }));
    await section
      .getByLabel("Code from your app, or a backup code")
      .fill(backupCodes[0]!);
    await section.getByRole("button", { name: "Unlock staff tools" }).click();
    await expect(
      section.getByText("Staff tools are unlocked for this session."),
    ).toBeVisible();
    await page.goto("/profile");
    await page.getByRole("link", { name: "Staff tools" }).click();
    await expect(page).toHaveURL("/staff");
    const menu = page.getByRole("navigation", { name: "Staff" });
    await expect(menu.getByText("GRIDLOCKED · STAFF")).toBeVisible();
    await expect(
      menu.getByText(`Signed in as ${account.username} · admin · 2-step on`),
    ).toBeVisible();
    await expectNoSeriousAxeViolations(page);
  });

  test("a user is refused /staff", async ({ page, request }) => {
    // Signed out: sign in first.
    await page.goto("/staff");
    await expect(page).toHaveURL(/\/sign-in/);

    const account = await createAccount(request);
    await signIn(page, account);
    await page.goto("/staff");
    await expect(page).toHaveURL("/");
    await page.goto("/profile");
    await expect(page.getByRole("link", { name: "Staff tools" })).toHaveCount(
      0,
    );
  });
});
