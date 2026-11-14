import { expect, test, type Page } from "@playwright/test";
import { createAccount, heading, hydrated } from "../helpers/accounts";
import { FANTASY_ORIGIN, ROUND_1, seedGame } from "../helpers/game";

// Teams (M6 Task 6): create, rename and remove, in an open game before round
// 1's lock. Each test starts from a freshly seeded game and a new account.

test.beforeEach(async ({ page, request }) => {
  await seedGame(request, ROUND_1.beforeLock);
  // Signing up through the page's own context signs it in.
  await createAccount(page.context().request, { origin: FANTASY_ORIGIN });
});

const createButton = (page: Page) =>
  page.getByRole("button", { name: "Create a team" });

/** Fills in the name and creates a team from the page it is on. */
async function createTeam(page: Page, name: string) {
  await hydrated(createButton(page));
  await page.getByLabel("Team name").fill(name);
  await createButton(page).click();
}

/** The row of the team list for `name`. */
const row = (page: Page, name: string) =>
  page.getByRole("listitem").filter({ hasText: name });

test("create a first team and land in its builder", async ({ page }) => {
  await page.goto("/team");
  await expect(heading(page)).toHaveText("No team yet");

  await hydrated(createButton(page));
  await page.getByLabel("Team name").fill("x".repeat(31));
  await createButton(page).click();
  await expect(
    page.getByText("A team name is 1 to 30 characters."),
  ).toBeVisible();

  await page.getByLabel("Team name").fill("Box Box");
  await createButton(page).click();
  await expect(page).toHaveURL("/team/1");
  await expect(heading(page)).toHaveText("Box Box");

  // With one team, Team goes straight to it.
  await page.goto("/team");
  await expect(page).toHaveURL("/team/1");
});

test("a second team shows in the list and on the profile", async ({ page }) => {
  await page.goto("/team");
  await createTeam(page, "Box Box");
  await expect(page).toHaveURL("/team/1");

  await page.getByRole("link", { name: "Your teams" }).click();
  await expect(page).toHaveURL("/team?list=1");
  await createTeam(page, "Undercut");
  await expect(page).toHaveURL("/team/2");

  await page.goto("/team");
  await expect(heading(page)).toHaveText("Your teams");
  await expect(row(page, "Box Box")).toContainText("Team 1");
  await expect(row(page, "Undercut")).toContainText("Team 2");

  await page.goto("/profile");
  const teams = page.getByRole("region", { name: "Teams" });
  await expect(teams.getByRole("link", { name: /Box Box/ })).toHaveAttribute(
    "href",
    "/team/1",
  );
  await expect(teams.getByRole("link", { name: /Undercut/ })).toHaveAttribute(
    "href",
    "/team/2",
  );
});

test("rename and delete", async ({ page }) => {
  await page.goto("/team");
  await createTeam(page, "Box Box");
  await page.goto("/team?list=1");
  await createTeam(page, "Undercut");
  await page.goto("/team");

  await hydrated(row(page, "Box Box").getByRole("button", { name: "Rename" }));
  await row(page, "Box Box").getByRole("button", { name: "Rename" }).click();
  const rename = page.getByRole("dialog", { name: "Rename team" });
  await rename.getByLabel("Team name").fill("Slipstream");
  await rename.getByRole("button", { name: "Save" }).click();
  await expect(rename).toBeHidden();
  await expect(row(page, "Slipstream")).toContainText("Team 1");

  await row(page, "Undercut").getByRole("button", { name: "Remove" }).click();
  const remove = page.getByRole("dialog", { name: "Delete this team?" });
  await remove.getByRole("button", { name: "Delete" }).click();
  await expect(remove).toBeHidden();
  await expect(row(page, "Undercut")).toHaveCount(0);
  await expect(row(page, "Slipstream")).toBeVisible();
  // A slot is free again.
  await expect(createButton(page)).toBeVisible();
});
