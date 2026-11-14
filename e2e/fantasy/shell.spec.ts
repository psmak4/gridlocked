import { expect, test, type Page } from "@playwright/test";
import {
  createAccount,
  heading,
  hydrated,
  signInButton,
} from "../helpers/accounts";
import { clearGame, FANTASY_ORIGIN, ROUND_1 } from "../helpers/game";

// The app shell (M6 Task 5): the bottom nav on a phone, the side menu from
// 1024 px, Team and Leagues for someone signed in, and "No game yet" before
// a game opens. Each test starts from an empty database with no game.

const bottomNav = (page: Page) => page.locator('[data-slot="bottom-nav"]');
const sideMenu = (page: Page) => page.locator('[data-slot="side-menu"]');

test.beforeEach(async ({ request }) => {
  await clearGame(request, ROUND_1.beforeLock);
});

/**
 * A new account, signed in on `page`: signing up through the page's own
 * context leaves its session cookie there.
 */
async function signedIn(page: Page) {
  await createAccount(page.context().request, { origin: FANTASY_ORIGIN });
}

test.describe("at 390×844", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("the bottom nav is visible and the side menu isn't", async ({
    page,
  }) => {
    await signedIn(page);
    await page.goto("/team");
    await expect(bottomNav(page)).toBeVisible();
    await expect(sideMenu(page)).toBeHidden();
    await expect(
      bottomNav(page).getByRole("link", { name: "Team" }),
    ).toHaveAttribute("aria-current", "page");
  });
});

test.describe("at 1280×800", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("the side menu replaces it", async ({ page }) => {
    await signedIn(page);
    await page.goto("/leagues");
    await expect(sideMenu(page)).toBeVisible();
    await expect(bottomNav(page)).toBeHidden();
    await expect(
      sideMenu(page).getByRole("link", { name: "Leagues" }),
    ).toHaveAttribute("aria-current", "page");
    await expect(
      sideMenu(page).getByRole("link", { name: "GRIDLOCKED" }),
    ).toBeVisible();
  });
});

test("a logged-out visitor opening /team goes to sign in and comes back", async ({
  page,
  request,
}) => {
  // Made on a context of its own, so this page stays logged out.
  const account = await createAccount(request, { origin: FANTASY_ORIGIN });

  await page.goto("/team");
  await expect(page).toHaveURL("/sign-in?next=%2Fteam");
  await hydrated(signInButton(page));
  await page.getByLabel("Email").fill(account.email);
  await page.getByLabel("Password").fill(account.password);
  await signInButton(page).click();

  await expect(page).toHaveURL("/team");
  await expect(heading(page)).toHaveText("No game yet");
});

test("with no game, Team shows No game yet", async ({ page }) => {
  await signedIn(page);
  await page.goto("/team");
  await expect(heading(page)).toHaveText("No game yet");
  await expect(
    page.getByText("The game opens before the first race."),
  ).toBeVisible();
});
