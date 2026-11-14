import { expect, test, type Page } from "@playwright/test";
import {
  createAccount,
  emailTo,
  expectNoSeriousAxeViolations,
  heading,
  hydrated,
  linkIn,
  newEmail,
  newUsername,
  ownAddress,
  PASSWORD,
} from "./helpers/accounts";

// Runs against the VITE_LOCAL_DB=1 build, at phone size (playwright.config).

test.beforeEach(async ({ page }) => {
  await ownAddress(page);
});

async function fillEmailForm(
  page: Page,
  input: { email: string; username: string; password?: string },
) {
  await page.getByLabel("Email").fill(input.email);
  await page.getByLabel("Password").fill(input.password ?? PASSWORD);
  await page.getByLabel("Username").fill(input.username);
}

/** Signs a new person in by magic link, and returns their address. */
async function arriveByMagicLink(page: Page) {
  const email = newEmail();
  await page.goto("/sign-up");
  await page.getByRole("link", { name: "Email me a sign-in link" }).click();
  await expect(page).toHaveURL(/\/sign-in\?mode=link/);
  await hydrated(page.getByRole("button", { name: "Send link" }));
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Send link" }).click();
  await expect(heading(page)).toHaveText("Check your email");
  const link = linkIn(await emailTo(page.request, email, "sign-in link"));
  await page.goto(link);
  return email;
}

test.describe("Choose a way in", () => {
  test("offers email, a link and sign-in, and no Discord when it isn't set up", async ({
    page,
  }) => {
    await page.goto("/sign-up");
    await expect(heading(page)).toHaveText("GRIDLOCKED");
    await expect(
      page.getByRole("link", { name: "Sign up with email" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Email me a sign-in link" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Continue with Discord" }),
    ).toHaveCount(0);
    await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  });

  test("says the terms come in the next step, and keeps the unofficial line once", async ({
    page,
  }) => {
    await page.goto("/sign-up");
    await expect(
      page.getByText("You'll accept the terms in the next step"),
    ).toBeVisible();
    await expect(page.getByText("By continuing you agree")).toHaveCount(0);
    await expect(page.getByText("You must be 16 or older.")).toBeVisible();
    await expect(
      page.getByText(
        "Unofficial. Not affiliated with Formula 1 or the FIA. Data from Jolpica and OpenF1.",
      ),
    ).toHaveCount(1);
  });

  test("a logged-out visitor's page stays cacheable", async ({ request }) => {
    const response = await request.get("/sign-up");
    expect(response.status()).toBe(200);
    expect(response.headers()["set-cookie"]).toBeUndefined();
    expect(response.headers()["cache-control"] ?? "").not.toMatch(
      /no-store|private/,
    );
  });
});

test.describe("signing up", () => {
  test("sign up with email, verify, onboard, land home", async ({ page }) => {
    const email = newEmail();
    const username = newUsername();
    await page.goto("/sign-up");
    await page.getByRole("link", { name: "Sign up with email" }).click();
    await expect(heading(page)).toHaveText("Create your account");
    await hydrated(page.getByRole("button", { name: "Create account" }));
    await fillEmailForm(page, { email, username });
    await page.getByRole("checkbox", { name: "I'm 16 or older" }).check();
    await page.getByRole("checkbox", { name: /I agree to the Terms/ }).check();
    await page.getByRole("button", { name: "Create account" }).click();

    await expect(heading(page)).toHaveText("Check your email");
    await expect(page.getByText(email)).toBeVisible();
    // An ordinary day: no notice.
    await expect(page.getByText("It might take a while today")).toHaveCount(0);

    const link = linkIn(
      await emailTo(page.request, email, "Confirm your email"),
    );
    await page.goto(link);
    await expect(page).toHaveURL(/\/welcome\/favorites$/);
    await expect(heading(page)).toHaveText("Who do you support?");
    await expect(page.getByText("STEP 1 OF 2")).toBeVisible();
    await hydrated(page.getByRole("button", { name: "Continue" }));
    await page.getByLabel("Your country (optional)").selectOption("IT");
    await page.getByRole("button", { name: "Continue" }).click();

    await expect(page).toHaveURL(/\/welcome\/spoilers$/);
    await expect(heading(page)).toHaveText("Do you watch live?");
    await expect(page.getByText("STEP 2 OF 2")).toBeVisible();
    await expect(
      page.getByRole("radio", { name: /Hide results until I've watched/ }),
    ).toBeChecked();
    await page.getByRole("button", { name: "Finish" }).click();

    await expect(page).toHaveURL("/");
    await expect(heading(page)).toHaveText("GRIDLOCKED");
    await expect(page.getByText(`Signed in as ${username}`)).toBeVisible();
  });

  test("a magic link signs a new person in, then Finish signing up, then home", async ({
    page,
  }) => {
    await arriveByMagicLink(page);
    await expect(page).toHaveURL(/\/welcome$/);
    await expect(heading(page)).toHaveText("Finish signing up");
    await hydrated(page.getByRole("button", { name: "Finish signing up" }));

    const username = newUsername();
    await page.getByLabel("Username").fill(username);
    await page.getByRole("checkbox", { name: "I'm 16 or older" }).check();
    await page.getByRole("checkbox", { name: /I agree to the Terms/ }).check();
    await page.getByRole("button", { name: "Finish signing up" }).click();

    await expect(page).toHaveURL(/\/welcome\/favorites$/);
    await page.getByRole("link", { name: "Skip" }).click();
    await expect(page).toHaveURL(/\/welcome\/spoilers$/);
    await page.getByRole("button", { name: "Finish" }).click();
    await expect(page).toHaveURL("/");
    await expect(page.getByText(`Signed in as ${username}`)).toBeVisible();
  });

  test("a person who skips Finish signing up can't reach home", async ({
    page,
  }) => {
    await arriveByMagicLink(page);
    await expect(page).toHaveURL(/\/welcome$/);

    await page.goto("/");
    await expect(page).toHaveURL(/\/welcome$/);
    await page.goto("/welcome/favorites");
    await expect(page).toHaveURL(/\/welcome$/);
    await page.goto("/sign-up");
    await expect(page).toHaveURL(/\/welcome$/);

    // The terms stay readable, so they can be read before agreeing.
    await page.goto("/legal/terms");
    await expect(page).toHaveURL(/\/legal\/terms$/);
    await expect(heading(page)).toContainText("Terms");

    // A signed-in page is private.
    const welcome = await page.request.get("/welcome");
    expect(welcome.headers()["cache-control"]).toBe("private, no-store");
  });

  test("the two boxes are required", async ({ page }) => {
    const email = newEmail();
    await page.goto("/sign-up/email");
    await expect(
      page.getByRole("button", { name: "Create account" }),
    ).toBeEnabled();
    await fillEmailForm(page, { email, username: newUsername() });
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByText("Confirm you're 16 or older.")).toBeVisible();
    await expect(
      page.getByText("Accept the terms, privacy policy and community rules"),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/sign-up\/email$/);

    // No account was made: no email went out.
    const listed = await page.request.get(
      `/api/test/emails?to=${encodeURIComponent(email)}`,
    );
    expect(((await listed.json()) as { emails: unknown[] }).emails).toEqual([]);

    // The same on Finish signing up.
    await arriveByMagicLink(page);
    await hydrated(page.getByRole("button", { name: "Finish signing up" }));
    await page.getByLabel("Username").fill(newUsername());
    await page.getByRole("button", { name: "Finish signing up" }).click();
    await expect(page.getByText("Confirm you're 16 or older.")).toBeVisible();
    await expect(
      page.getByText("Accept the terms, privacy policy and community rules"),
    ).toBeVisible();
    await expect(page).toHaveURL(/\/welcome$/);
  });

  test("a reserved username shows why", async ({ page, request }) => {
    const taken = (await createAccount(request)).username;
    await page.goto("/sign-up/email");
    await expect(
      page.getByRole("button", { name: "Create account" }),
    ).toBeEnabled();
    await page.evaluate(() => {
      (window as unknown as { __kept: boolean }).__kept = true;
    });
    const username = page.getByLabel("Username");

    await username.fill("admin");
    await username.blur();
    await expect(
      page.getByText("That name is reserved. Try another."),
    ).toBeVisible();

    await username.fill(taken);
    await username.blur();
    await expect(page.getByText("That name is taken.")).toBeVisible();

    await username.fill("a!");
    await username.blur();
    await expect(
      page.getByText("Use 3 to 20 letters, numbers, underscores or dots."),
    ).toBeVisible();

    await username.fill(newUsername());
    await username.blur();
    await expect(page.getByText(/That name is|Use 3 to 20/)).toHaveCount(0);

    // All of that without a reload.
    expect(
      await page.evaluate(
        () => (window as unknown as { __kept?: boolean }).__kept,
      ),
    ).toBe(true);
  });

  test("the busy notice shows when the allowance is tight", async ({
    page,
    context,
  }) => {
    // A local-build override (the cookie), so no other test is held up by a
    // real shortage. The check itself is tested against the database.
    await context.addCookies([
      { name: "gl-test-busy", value: "1", url: "http://localhost:3100" },
    ]);
    const email = newEmail();
    await page.goto("/sign-up/email");
    await expect(
      page.getByRole("button", { name: "Create account" }),
    ).toBeEnabled();
    await fillEmailForm(page, { email, username: newUsername() });
    await page.getByRole("checkbox", { name: "I'm 16 or older" }).check();
    await page.getByRole("checkbox", { name: /I agree to the Terms/ }).check();
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(heading(page)).toHaveText("Check your email");
    await expect(page.getByText("It might take a while today")).toBeVisible();
    await expect(page.getByText(/emails are queued/)).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Continue with Discord instead" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Look around for now" }),
    ).toBeVisible();
  });

  test("an expired link offers a new one", async ({ page }) => {
    const email = newEmail();
    await page.goto("/sign-in?mode=link");
    await hydrated(page.getByRole("button", { name: "Send link" }));
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Send link" }).click();
    await expect(heading(page)).toHaveText("Check your email");
    const link = linkIn(await emailTo(page.request, email, "sign-in link"));

    // A link works once; the second time it has been used up.
    await page.goto(link);
    await expect(page).toHaveURL(/\/welcome$/);
    await page.goto(link);
    await expect(page).toHaveURL(/\/auth-error\?error=INVALID_TOKEN/);
    await expect(heading(page)).toHaveText("That link has expired");
    await hydrated(page.getByRole("button", { name: "Email me a new link" }));
    await page.getByLabel("Email").fill(email);
    await page.getByRole("button", { name: "Email me a new link" }).click();
    await expect(heading(page)).toHaveText("Check your email");
    const again = await emailTo(page.request, email, "sign-in link");
    expect(linkIn(again)).not.toBe(link);
  });

  test("the Create account button stays disabled until hydrated", async ({
    page,
  }) => {
    await page.route("**/assets/**", (route) => route.abort());
    await page.goto("/sign-up/email");
    await expect(
      page.getByRole("button", { name: "Create account" }),
    ).toBeDisabled();
  });

  test("a form that never hydrated doesn't put the password in the address", async ({
    page,
  }) => {
    await page.route("**/assets/**", (route) => route.abort());
    await page.goto("/sign-up/email");
    await page.getByLabel("Password").fill("secret-secret-secret");
    await page.getByLabel("Password").press("Enter");
    await expect(page).not.toHaveURL(/secret/);
    expect(page.url()).not.toContain("password");
  });
});

test.describe("keyboard", () => {
  test("each form works with the keyboard alone", async ({ page }) => {
    const email = newEmail();
    await page.goto("/sign-up/email");
    await expect(
      page.getByRole("button", { name: "Create account" }),
    ).toBeEnabled();
    await page.getByLabel("Email").focus();
    await page.keyboard.type(email);
    await page.keyboard.press("Tab");
    await page.keyboard.type(PASSWORD);
    await page.keyboard.press("Tab");
    await page.keyboard.type(newUsername());
    await page.keyboard.press("Tab");
    await page.keyboard.press("Space");
    await page.keyboard.press("Tab");
    await page.keyboard.press("Space");
    await expect(
      page.getByRole("checkbox", { name: "I'm 16 or older" }),
    ).toBeChecked();
    await expect(
      page.getByRole("checkbox", { name: /I agree to the Terms/ }),
    ).toBeChecked();
    for (let i = 0; i < 8; i++) {
      const onButton = await page.evaluate(
        () => document.activeElement?.textContent === "Create account",
      );
      if (onButton) break;
      await page.keyboard.press("Tab");
    }
    await page.keyboard.press("Enter");
    await expect(heading(page)).toHaveText("Check your email");

    // Onboarding: the team tiles, the selects and the radios.
    await page.getByRole("link", { name: "Look around for now" }).focus();
    await page.keyboard.press("Enter");
    await expect(heading(page)).toHaveText("Who do you support?");
    await hydrated(page.getByRole("button", { name: "Continue" }));
    await page.getByRole("button", { name: "Continue" }).focus();
    await page.keyboard.press("Enter");
    await expect(heading(page)).toHaveText("Do you watch live?");
    const hide = page.getByRole("radio", { name: /Hide results/ });
    const show = page.getByRole("radio", { name: /Show me everything/ });
    await hide.focus();
    await page.keyboard.press("ArrowDown");
    await expect(show).toBeChecked();
    await page.getByRole("button", { name: "Finish" }).focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL("/");
  });
});

test.describe("accessibility", () => {
  for (const scheme of ["light", "dark"] as const) {
    test(`an axe check finds nothing serious (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      const check = async (path: string, ready: string | RegExp) => {
        await page.goto(path);
        await expect(
          page.getByRole("heading", { level: 1 }),
          path,
        ).toContainText(ready);
        await expect(page.locator("body")).toBeVisible();
        await expectNoSeriousAxeViolations(page);
      };

      await check("/sign-up", "GRIDLOCKED");
      await check("/sign-up/email", "Create your account");
      await check("/sign-in", "Sign in");
      await check("/sign-in?mode=link", "Email me a sign-in link");
      await check("/reset-password", "Reset your password");
      await check("/auth-error?error=INVALID_TOKEN", "That link has expired");
      await check("/legal/terms", "Terms");

      // The screens that need someone signed in.
      const email = newEmail();
      await page.goto("/sign-up/email");
      await expect(
        page.getByRole("button", { name: "Create account" }),
      ).toBeEnabled();
      await fillEmailForm(page, { email, username: newUsername() });
      await page.getByRole("checkbox", { name: "I'm 16 or older" }).check();
      await page
        .getByRole("checkbox", { name: /I agree to the Terms/ })
        .check();
      await page.getByRole("button", { name: "Create account" }).click();
      await expect(heading(page)).toHaveText("Check your email");
      await expectNoSeriousAxeViolations(page);
      await check("/welcome/favorites", "Who do you support?");
      await check("/welcome/spoilers", "Do you watch live?");

      await page.context().clearCookies();
      await arriveByMagicLink(page);
      await expect(heading(page)).toHaveText("Finish signing up");
      await expectNoSeriousAxeViolations(page);
    });
  }
});
