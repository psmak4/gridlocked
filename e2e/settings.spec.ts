import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import {
  createAccount,
  emailTo,
  expectNoSeriousAxeViolations,
  heading,
  hydrated,
  linkIn,
  newUsername,
  ORIGIN,
  ownAddress,
  pageHydrated,
  postFromPage,
  signIn,
  signInButton,
  verifyByEmail,
} from "./helpers/accounts";

test.beforeEach(async ({ page }) => {
  await ownAddress(page);
});

/** "26 Nov" (or "26 Nov 2027"), the way the settings pages write a day. */
const DAY = /\d{1,2} [A-Z][a-z]{2,3}( \d{4})?/;

test.describe("profile", () => {
  test("shows the username, the trust level in plain words and the join date", async ({
    page,
    request,
  }) => {
    const account = await createAccount(request);
    await signIn(page, account);
    await page.goto("/profile");
    await expect(heading(page)).toHaveText(account.username);
    await expect(page.getByText("New", { exact: true })).toBeVisible();
    await expect(page.getByText(/^New means you can /)).toBeVisible();
    await expect(page.getByText("JOINED")).toBeVisible();
    await page.getByRole("link", { name: "Settings", exact: true }).click();
    await expect(heading(page)).toHaveText("Settings");
  });

  test("a logged-out visitor is sent to sign in", async ({ page, request }) => {
    // The redirect itself is private: it depends on the cookie.
    const bounce = await request.get("/settings", { maxRedirects: 0 });
    expect(bounce.status()).toBeGreaterThanOrEqual(300);
    expect(bounce.status()).toBeLessThan(400);
    expect(bounce.headers()["cache-control"]).toBe("private, no-store");
    await page.goto("/settings");
    await expect(page).toHaveURL(/\/sign-in$/);
    await page.goto("/profile");
    await expect(page).toHaveURL(/\/sign-in$/);
  });
});

test.describe("settings", () => {
  test("a username change shows the next date, and a second is refused", async ({
    page,
    request,
  }) => {
    const account = await createAccount(request);
    await signIn(page, account);
    await page.goto("/settings");
    await page.getByRole("link", { name: /^Username/ }).click();
    await expect(heading(page)).toHaveText("Username");
    await expect(page.getByText("You can change it now.")).toBeVisible();
    await hydrated(page.getByRole("button", { name: "Change username" }));

    const first = newUsername();
    await page.getByLabel("New username").fill(first);
    await page.getByRole("button", { name: "Change username" }).click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: `Your username is now ${first}.` }),
    ).toBeVisible();
    await expect(
      page.getByText(
        new RegExp(`You can change it again from ${DAY.source}\\.`),
      ),
    ).toBeVisible();

    // A second rename inside the 30 days: the server says no, and when.
    await page.getByLabel("New username").fill(newUsername());
    await page.getByRole("button", { name: "Change username" }).click();
    await expect(
      page.getByRole("alert").filter({
        hasText: new RegExp(`You can change it again from ${DAY.source}`),
      }),
    ).toBeVisible();

    // Settings shows the new name and the date, and so does a reload.
    await page.goto("/settings");
    await expect(
      page.getByRole("link", { name: new RegExp(`^Username ${first}`) }),
    ).toContainText(/you can change it again from/);
    await page.goto("/profile");
    await expect(heading(page)).toHaveText(first);
  });

  test("spoiler and favorite changes persist after a reload", async ({
    page,
    request,
  }) => {
    const account = await createAccount(request);
    await signIn(page, account);
    await page.goto("/settings");
    const spoilers = page.getByRole("switch", {
      name: "Hide results until I've watched",
    });
    await expect(spoilers).toBeChecked();
    await spoilers.click();
    await expect(
      page.getByRole("status").filter({ hasText: "Saved." }),
    ).toBeVisible();
    await expect(spoilers).not.toBeChecked();

    await page.getByRole("link", { name: /^Favorites/ }).click();
    await expect(heading(page)).toHaveText("Favorites");
    await hydrated(page.getByRole("button", { name: "Save" }));
    await page.getByLabel("Your country (optional)").selectOption("IT");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Saved." }),
    ).toBeVisible();

    await page.reload();
    await expect(page.getByLabel("Your country (optional)")).toHaveValue("IT");
    await page.goto("/settings");
    await expect(
      page.getByRole("switch", { name: "Hide results until I've watched" }),
    ).not.toBeChecked();
    await expect(page.getByRole("link", { name: /^Favorites/ })).toContainText(
      "Italy",
    );
    await page.goto("/profile");
    await expect(page.getByText("Italy")).toBeVisible();
  });

  test("the theme choice is kept on this device", async ({ page, request }) => {
    const account = await createAccount(request);
    await signIn(page, account);
    await page.goto("/settings");
    const theme = page.getByRole("radiogroup", { name: "Theme" });
    await expect(theme.getByRole("radio", { name: "Device" })).toBeChecked();
    // The radios are dressed as tabs: a tap lands on the label.
    await theme.getByText("Dark", { exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(
      page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", {
        name: "Dark",
      }),
    ).toBeChecked();
    // And the keyboard: arrows move along the group.
    await page
      .getByRole("radiogroup", { name: "Theme" })
      .getByRole("radio", { name: "Dark" })
      .focus();
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect(
      page.getByRole("radiogroup", { name: "Theme" }).getByRole("radio", {
        name: "Device",
      }),
    ).toBeChecked();
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", /./);
  });

  test("the last sign-in method can't be removed", async ({
    page,
    request,
  }) => {
    // A password-only account: its one way in is the password.
    const account = await createAccount(request);
    await signIn(page, account);
    await page.goto("/settings/sign-in");
    await expect(heading(page)).toHaveText("Sign-in methods");
    const method = page.getByRole("listitem").filter({
      hasText: "Email and password",
    });
    await expect(method).toBeVisible();
    await expect(
      method.getByText("Your only way to sign in, so it can't be removed."),
    ).toBeVisible();
    await expect(method.getByRole("button", { name: /Remove/ })).toBeDisabled();
    // Discord isn't set up on this build, so there's nothing to link.
    await expect(page.getByRole("button", { name: /Discord/ })).toHaveCount(0);

    // Better Auth's own unlink route is closed: settings is the only path,
    // and the server refuses the last method there (Vitest).
    const unlink = await postFromPage(page, "/api/auth/unlink-account", {
      providerId: "credential",
    });
    expect(unlink.status).toBe(404);

    // Still signs in with the password.
    await page.context().clearCookies();
    await signIn(page, account);
  });

  test("delete: the wrong username keeps the button disabled, the email link finishes, and sign-in then fails", async ({
    page,
    request,
  }) => {
    const account = await createAccount(request);
    await verifyByEmail(page, account.email);
    await page.goto("/settings");
    await page.getByRole("link", { name: /^Delete my account/ }).click();
    await expect(heading(page)).toHaveText("Delete your account");
    await expect(
      page.getByText("Your posts stay, without your name"),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Download my data first" }),
    ).toHaveAttribute("href", "/settings/data");

    const button = page.getByRole("button", { name: "Delete my account" });
    const field = page.getByLabel("Type your username to confirm");
    await pageHydrated(page);
    await expect(button).toBeDisabled();
    await field.fill("someone_else");
    await expect(button).toBeDisabled();
    await field.fill(account.username.toUpperCase());
    await expect(button).toBeEnabled();
    await button.click();
    await expect(
      page.getByRole("status").filter({ hasText: "Check your email" }),
    ).toBeVisible();

    const link = linkIn(
      await emailTo(page.request, account.email, "Confirm deleting"),
    );
    expect(link).toMatch(/\/settings\/delete\/confirm\?token=/);
    // The link opens a page that asks once more; opening it deletes nothing.
    await page.context().clearCookies();
    await page.goto(link);
    await expect(heading(page)).toHaveText("Delete your account?");
    await page.getByRole("button", { name: "Delete my account" }).click();
    await expect(heading(page)).toHaveText("Your account is deleted");

    // The link is used up, and the account can't sign in.
    await page.goto(link);
    await page.getByRole("button", { name: "Delete my account" }).click();
    await expect(heading(page)).toHaveText("That link has expired");

    await page.goto("/sign-in");
    await hydrated(signInButton(page));
    await page.getByLabel("Email").fill(account.email);
    await page.getByLabel("Password").fill(account.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(
      page.getByText("That email and password don't match."),
    ).toBeVisible();
  });

  test("with a document to accept, the data and delete pages still work (ruling 52)", async ({
    page,
    request,
  }) => {
    const account = await createAccount(request);
    await verifyByEmail(page, account.email);
    // As if a new version of the terms needed accepting again.
    const cleared = await request.post("/api/test/clear-acceptances", {
      headers: { origin: ORIGIN },
      data: { email: account.email },
    });
    expect(cleared.status()).toBe(200);
    await page.goto("/settings");
    await expect(page).toHaveURL(/\/welcome$/);

    await page.goto("/settings/data");
    await expect(heading(page)).toHaveText("Download my data");
    await expect(page.getByRole("link", { name: "Back" })).toHaveAttribute(
      "href",
      "/welcome",
    );
    await page.getByRole("button", { name: "Request my data" }).click();
    await expect(page.getByText("Ready within a few hours")).toBeVisible();

    await page.goto("/settings/delete");
    await expect(heading(page)).toHaveText("Delete your account");
    await expect(page.getByRole("link", { name: "Back" })).toHaveAttribute(
      "href",
      "/welcome",
    );
    await pageHydrated(page);
    await page
      .getByLabel("Type your username to confirm")
      .fill(account.username);
    await page.getByRole("button", { name: "Delete my account" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Check your email" }),
    ).toBeVisible();
    await page.goto(
      linkIn(await emailTo(page.request, account.email, "Confirm deleting")),
    );
    await page.getByRole("button", { name: "Delete my account" }).click();
    await expect(heading(page)).toHaveText("Your account is deleted");
  });

  test("request an export, run the job, download the file", async ({
    page,
    request,
  }) => {
    const account = await createAccount(request);
    await signIn(page, account);
    await page.goto("/settings");
    await page.getByRole("link", { name: /^Download my data/ }).click();
    await expect(heading(page)).toHaveText("Download my data");
    await page.getByRole("button", { name: "Request my data" }).click();
    await expect(page.getByText("Ready within a few hours")).toBeVisible();
    // Asking again while one is open changes nothing.
    await expect(
      page.getByRole("button", { name: "Request my data" }),
    ).toHaveCount(0);

    // The scheduler isn't running locally: run the job now.
    const ran = await request.post("/api/test/run-exports", {
      headers: { origin: ORIGIN },
    });
    expect(ran.status()).toBe(200);

    await page.reload();
    const download = page.getByRole("link", { name: "Download the file" });
    await expect(download).toBeVisible();
    await expect(
      page.getByText(new RegExp(`Works until ${DAY.source}`)),
    ).toBeVisible();
    const [file] = await Promise.all([
      page.waitForEvent("download"),
      download.click(),
    ]);
    const body = JSON.parse(await readFile((await file.path())!, "utf8")) as {
      account: { username: string; email: string };
    };
    expect(body.account.username).toBe(account.username.toLowerCase());
    expect(body.account.email).toBe(account.email.toLowerCase());

    // The email has the same link.
    await emailTo(page.request, account.email, "data export is ready");
  });

  test("the settings page is private, no-store", async ({ page, request }) => {
    const account = await createAccount(request);
    await signIn(page, account);
    for (const path of [
      "/profile",
      "/settings",
      "/settings/username",
      "/settings/favorites",
      "/settings/sign-in",
      "/settings/security",
      "/settings/data",
      "/settings/delete",
      "/settings/delete/confirm?token=nothing",
    ]) {
      const response = await page.goto(path);
      expect(response?.status(), path).toBe(200);
      expect(response?.headers()["cache-control"], path).toBe(
        "private, no-store",
      );
    }
    // Logged out, the confirmation page is still private (its link is a key).
    await page.context().clearCookies();
    const response = await page.goto("/settings/delete/confirm?token=nothing");
    expect(response?.headers()["cache-control"]).toBe("private, no-store");
  });

  test("an axe check finds nothing serious (light and dark, every screen)", async ({
    page,
    request,
  }) => {
    const account = await createAccount(request);
    await signIn(page, account);
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const path of [
        "/profile",
        "/settings",
        "/settings/username",
        "/settings/favorites",
        "/settings/sign-in",
        "/settings/security",
        "/settings/data",
        "/settings/delete",
        "/settings/delete/confirm?token=nothing",
      ]) {
        await page.goto(path);
        await expect(heading(page)).toBeVisible();
        await expectNoSeriousAxeViolations(page);
      }
    }
  });
});
