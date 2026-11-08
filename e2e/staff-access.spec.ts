import { expect, test } from "@playwright/test";
import {
  createAccount,
  heading,
  ownAddress,
  postFromPage,
  signIn,
} from "./helpers/accounts";
import { makeAdmin, setUpTotp, totpCode } from "./helpers/staff";

test.beforeEach(async ({ page }) => {
  await ownAddress(page);
});

test.describe("staff access", () => {
  test("a new admin sets up TOTP and keeps the backup codes", async ({
    page,
    request,
  }) => {
    const account = await createAccount(request);
    await makeAdmin(request, account.email);
    await signIn(page, account);

    await page.goto("/settings/security");
    await expect(heading(page)).toHaveText("Password and security");
    const section = page.getByRole("region", { name: "Two-step sign-in" });
    await expect(
      section.getByText("Staff tools need two-step sign-in."),
    ).toBeVisible();

    const { backupCodes } = await setUpTotp(page, account.password);
    expect(backupCodes).toHaveLength(10);
    for (const code of backupCodes) expect(code).toMatch(/^\S{5,}$/);
    await expect(
      section.getByText("Each one works once. You won't see them again."),
    ).toBeVisible();

    // Shown once: a reload has the factor on and no codes.
    await page.reload();
    await expect(section.getByText("Two-step sign-in is on.")).toBeVisible();
    await expect(section.getByTestId("backup-codes")).toHaveCount(0);

    // A kept backup code unlocks staff tools for this session.
    await section
      .getByLabel("Code from your app, or a backup code")
      .fill(backupCodes[0]!);
    await section.getByRole("button", { name: "Unlock staff tools" }).click();
    await expect(
      section.getByText("Staff tools are unlocked for this session."),
    ).toBeVisible();
    await page.reload();
    await expect(
      section.getByText("Staff tools are unlocked for this session."),
    ).toBeVisible();
  });

  test("an ordinary account sees no two-step set-up", async ({
    page,
    request,
  }) => {
    const account = await createAccount(request);
    await signIn(page, account);
    await page.goto("/settings/security");
    await expect(heading(page)).toHaveText("Password and security");
    await expect(page.getByLabel("Current password")).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Two-step sign-in" }),
    ).toHaveCount(0);
  });

  test("the impersonation banner shows and Stop returns", async ({
    page,
    request,
  }) => {
    const target = await createAccount(request);
    const admin = await createAccount(request);
    await makeAdmin(request, admin.email);
    await signIn(page, admin);
    const { setupKey } = await setUpTotp(page, admin.password);
    const section = page.getByRole("region", { name: "Two-step sign-in" });
    await section
      .getByLabel("Code from your app, or a backup code")
      .fill(totpCode(setupKey));
    await section.getByRole("button", { name: "Unlock staff tools" }).click();
    await expect(
      section.getByText("Staff tools are unlocked for this session."),
    ).toBeVisible();

    const started = await postFromPage(page, "/api/test/impersonate", {
      username: target.username,
      reason: "Checking a support request",
    });
    expect(started.status).toBe(200);

    await page.goto("/");
    const banner = page.getByRole("region", { name: "Impersonation" });
    await expect(banner).toContainText(`Viewing as ${target.username}`);
    await expect(
      page.getByText(`Signed in as ${target.username}`),
    ).toBeVisible();

    // On every page, and nothing can be changed.
    await page.goto("/settings");
    await expect(banner).toBeVisible();
    await page
      .getByRole("switch", { name: "Hide results until I've watched" })
      .click();
    await expect(
      page.getByRole("alert").filter({ hasText: "This session is read-only." }),
    ).toBeVisible();
    await page.goto("/profile");
    await expect(banner).toBeVisible();

    await banner.getByRole("button", { name: "Stop" }).click();
    await expect(page).toHaveURL("/");
    await expect(
      page.getByText(`Signed in as ${admin.username}`),
    ).toBeVisible();
    await expect(banner).toHaveCount(0);
  });
});
