import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  createAccount,
  expectNoSeriousAxeViolations,
  heading,
  hydrated,
} from "../helpers/accounts";
import { FANTASY_ORIGIN, ROUND_1, seedGame } from "../helpers/game";
import { createTeam } from "../helpers/team";

// Leagues (M6 Task 12): create, join with a code, and leave, in an open game
// before round 1's lock. Each test starts from a freshly seeded game.

test.beforeEach(async ({ request }) => {
  await seedGame(request, ROUND_1.beforeLock);
});

/** A new account with "Box Box", signed in on `page`. */
async function player(page: Page) {
  await createAccount(page.context().request, { origin: FANTASY_ORIGIN });
  await createTeam(page);
}

/** Another person, on a browser of their own. */
async function someoneElse(browser: Browser) {
  const context = await browser.newContext({
    baseURL: FANTASY_ORIGIN,
    viewport: { width: 390, height: 844 },
  });
  return context.newPage();
}

/** Creates a league from /leagues/new and answers its code. */
async function createLeague(page: Page, name: string) {
  await page.goto("/leagues/new");
  const create = page.getByRole("button", { name: "Create league" });
  await hydrated(create);
  await page.getByLabel("League name").fill(name);
  await create.click();
  await expect(heading(page)).toHaveText(name);
  const code = await page
    .getByRole("group", { name: "Invite with code" })
    .locator("[data-join-code]")
    .textContent();
  expect(code).toMatch(/^[A-Z2-9]{10}$/);
  return code!;
}

/** Opens Join with a code on /leagues. */
async function openJoin(page: Page) {
  await page.goto("/leagues");
  const join = page.getByRole("button", { name: "Join with a code" });
  await hydrated(join);
  await join.click();
  return page.getByRole("dialog", { name: "Join a league" });
}

const yours = (page: Page) => page.getByRole("list", { name: "Your leagues" });

test("create a private league, copy its code, and a second account joins with it", async ({
  page,
  browser,
}) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await player(page);
  const code = await createLeague(page, "Monday Night League");
  await page.getByRole("button", { name: "Copy" }).click();
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(code);

  await page.getByRole("link", { name: "Done" }).click();
  await expect(yours(page)).toContainText("Monday Night League");
  await expect(yours(page)).toContainText("Private · 1 team");

  const friend = await someoneElse(browser);
  await player(friend);
  const sheet = await openJoin(friend);
  // A wrong code first: plain words, and the sheet stays open.
  await sheet.getByLabel("League code").fill("ABCDEFGHJK");
  await sheet.getByRole("button", { name: "Join league" }).click();
  await expect(sheet.getByText("No league has that code.")).toBeVisible();
  // Typed in lower case with a space, as someone would from a message.
  await sheet
    .getByLabel("League code")
    .fill(`${code.slice(0, 5).toLowerCase()} ${code.slice(5)}`);
  await sheet.getByRole("button", { name: "Join league" }).click();
  await expect(sheet).toBeHidden();
  await expect(
    friend.getByText("You joined Monday Night League."),
  ).toBeVisible();
  await expect(yours(friend)).toContainText("Private · 2 teams");

  // Home shows it too.
  await friend.goto("/");
  await expect(friend.getByRole("region", { name: "LEAGUES" })).toContainText(
    "Monday Night League",
  );
  await friend.context().close();
});

test("a user with two teams chooses which joins", async ({ page, browser }) => {
  await player(page);
  const code = await createLeague(page, "Two Team Cup");

  const friend = await someoneElse(browser);
  await player(friend);
  await friend.goto("/team?list=1");
  const another = friend.getByRole("button", { name: "Create a team" });
  await hydrated(another);
  await friend.getByLabel("Team name").fill("Undercut");
  await another.click();
  await expect(friend).toHaveURL("/team/2");

  const sheet = await openJoin(friend);
  await sheet.getByLabel("League code").fill(code);
  await sheet
    .getByLabel("Which of your teams joins")
    .selectOption({ label: "Undercut" });
  await sheet.getByRole("button", { name: "Join league" }).click();
  await expect(sheet).toBeHidden();
  // With two teams, a row names the team in it.
  await expect(yours(friend)).toContainText("Two Team Cup");
  await expect(yours(friend)).toContainText("Undercut");
  await expect(yours(friend)).not.toContainText("Box Box");
  await friend.context().close();
});

test("leave a league", async ({ page }) => {
  await player(page);
  await createLeague(page, "Short Stay");
  await page.goto("/leagues");
  const row = yours(page).getByRole("button", { name: /Short Stay/ });
  await hydrated(row);
  await row.click();
  const sheet = page.getByRole("dialog", { name: "Short Stay" });
  await expect(sheet).toContainText("Invite with code");
  await sheet.getByRole("button", { name: "Leave league" }).click();
  await expect(sheet).toContainText("Box Box leaves Short Stay.");
  await sheet.getByRole("button", { name: "Leave league" }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByText("You left Short Stay.")).toBeVisible();
  await expect(yours(page)).toHaveCount(0);
  await expect(page.getByText("You're not in any leagues yet.")).toBeVisible();
  // The automatic ones stay.
  await expect(
    page.getByRole("list", { name: "Automatic leagues" }),
  ).toContainText("Everyone");
});

for (const scheme of ["light", "dark"] as const) {
  test(`axe finds nothing serious on leagues, ${scheme}`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.emulateMedia({ colorScheme: scheme });
    await player(page);
    await createLeague(page, "Axe League");
    await expectNoSeriousAxeViolations(page);
    await page.goto("/leagues/new");
    await hydrated(page.getByRole("button", { name: "Create league" }));
    await page.getByText("Some races").click();
    await expectNoSeriousAxeViolations(page);
    const sheet = await openJoin(page);
    await expect(sheet).toBeVisible();
    await expectNoSeriousAxeViolations(page);
  });
}
