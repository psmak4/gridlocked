import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import {
  createAccount,
  heading,
  hydrated,
  ownAddress,
  postFromPage,
  signIn,
  signInButton,
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
    await hydrated(section.getByRole("button", { name: "Unlock staff tools" }));
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

  /** A new admin with TOTP on, signed out again. */
  async function adminWithTotp(page: Page, request: APIRequestContext) {
    const account = await createAccount(request);
    await makeAdmin(request, account.email);
    await signIn(page, account);
    const totp = await setUpTotp(page, account.password);
    await page.context().clearCookies();
    return { ...account, ...totp };
  }

  /** Email and password on the sign-in form, by keyboard. */
  async function startSignIn(
    page: Page,
    account: { email: string; password: string },
  ) {
    await page.goto("/sign-in");
    await hydrated(signInButton(page));
    await page.getByLabel("Email").fill(account.email);
    await page.getByLabel("Password").fill(account.password);
    await page.getByLabel("Password").press("Enter");
    await expect(heading(page)).toHaveText("Two-step sign-in");
  }

  test("password and TOTP sign-in reaches home", async ({ page, request }) => {
    const admin = await adminWithTotp(page, request);
    await startSignIn(page, admin);
    const field = page.getByLabel("Code from your authenticator app");
    await expect(field).toBeFocused();
    // Keyboard alone: a wrong code, then the right one, each with Enter.
    await page.keyboard.type("000000");
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("alert").filter({ hasText: "That code didn't work." }),
    ).toBeVisible();
    await field.fill(totpCode(admin.setupKey));
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL("/");
    await expect(
      page.getByText(`Signed in as ${admin.username}`),
    ).toBeVisible();
  });

  test("a backup code works once at sign-in", async ({ page, request }) => {
    const admin = await adminWithTotp(page, request);
    await startSignIn(page, admin);
    await page.getByRole("button", { name: "Use a backup code" }).click();
    const field = page.getByLabel("Backup code");
    await expect(field).toBeFocused();
    await field.fill(admin.backupCodes[0]!);
    await field.press("Enter");
    await expect(page).toHaveURL("/");
    await expect(
      page.getByText(`Signed in as ${admin.username}`),
    ).toBeVisible();

    // The same code again is refused; the next one works.
    await page.context().clearCookies();
    await startSignIn(page, admin);
    await page.getByRole("button", { name: "Use a backup code" }).click();
    await page.getByLabel("Backup code").fill(admin.backupCodes[0]!);
    await page.getByLabel("Backup code").press("Enter");
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: "That backup code didn't work." }),
    ).toBeVisible();
    // And back to the app's code is one switch away.
    await page
      .getByRole("button", { name: "Use the code from your app" })
      .click();
    await expect(
      page.getByLabel("Code from your authenticator app"),
    ).toBeVisible();
    await page.getByRole("button", { name: "Use a backup code" }).click();
    await page.getByLabel("Backup code").fill(admin.backupCodes[1]!);
    await page.getByLabel("Backup code").press("Enter");
    await expect(page).toHaveURL("/");
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

    const [stopped] = await Promise.all([
      page.waitForResponse(
        (r) =>
          r.request().method() === "POST" && r.url().includes("/_serverFn/"),
      ),
      banner.getByRole("button", { name: "Stop" }).click(),
    ]);
    // One cookie path: the admin's session cookie is set back exactly once.
    const sessionCookies = (await stopped.headersArray()).filter(
      (h) =>
        h.name.toLowerCase() === "set-cookie" &&
        /^(__Secure-)?better-auth\.session_token=[^;]+/.test(h.value),
    );
    expect(sessionCookies).toHaveLength(1);
    await expect(page).toHaveURL("/");
    await expect(
      page.getByText(`Signed in as ${admin.username}`),
    ).toBeVisible();
    await expect(banner).toHaveCount(0);
  });
});
