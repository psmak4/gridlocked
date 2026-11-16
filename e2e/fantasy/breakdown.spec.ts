import { expect, test, type Page } from "@playwright/test";
import {
  createAccount,
  expectNoSeriousAxeViolations,
  hydrated,
} from "../helpers/accounts";
import { FANTASY_ORIGIN, ROUND_1, moveClock, seedGame } from "../helpers/game";
import { buildTeam, createTeam, saveTeam } from "../helpers/team";

// The points breakdown and the driver sheet (M6 Task 11), on the seeded 2026
// game at phone size. A new account's spoiler protection is on, so a scored
// session stays covered until it's shown or marked as watched.

const TITLE = "Your points · Gridlocked";

test.beforeEach(async ({ request }) => {
  await seedGame(request, ROUND_1.beforeLock);
});

/** An account with a saved team in round 1. */
async function withTeam(page: Page) {
  await createAccount(page.context().request, { origin: FANTASY_ORIGIN });
  await createTeam(page);
  await buildTeam(page);
  await saveTeam(page);
}

const sessionPoints = (page: Page, label: string) =>
  page.getByRole("list", { name: `${label} points` });

test("open the breakdown from the team, switch sessions, open a driver's sheet", async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  await withTeam(page);
  await moveClock(request, ROUND_1.afterRace);

  await page.goto("/team/1");
  await page.getByRole("link", { name: "Points breakdown" }).click();
  await expect(page).toHaveURL("/team/1/points");
  await expect(
    page.getByRole("heading", { level: 1, name: "Your points" }),
  ).toBeVisible();
  await expect(
    page.getByText(/^Round 1 · Australian Grand Prix$/i),
  ).toBeVisible();

  // The race first, covered: nothing of it is on the page.
  await expect(page.getByText("Race — scores are in")).toBeVisible();
  await expect(sessionPoints(page, "Race")).toHaveCount(0);
  await expect(page.locator('[data-slot="points-pill"]')).toHaveCount(0);
  const watched = page.getByRole("button", { name: "Mark as watched" });
  await hydrated(watched);
  await watched.click();
  const race = sessionPoints(page, "Race");
  await expect(race.getByRole("listitem")).toHaveCount(7);
  // Qualifying is still hidden, so the weekend's total is too.
  await expect(page.locator('[data-slot="points-pill"]')).toHaveCount(0);

  // Qualifying: Show it, for this page only.
  await page.getByRole("tab", { name: "Qualifying" }).click();
  await expect(page.getByText("Qualifying — scores are in")).toBeVisible();
  await page.getByRole("button", { name: "Show it" }).click();
  await expect(page).toHaveURL(/[?&]show=/);
  const quali = sessionPoints(page, "Qualifying");
  await expect(quali.getByRole("listitem")).toHaveCount(7);
  await expect(page.locator('[data-slot="points-pill"]')).toHaveCount(1);
  await expect(page).toHaveTitle(TITLE);

  // Back on the race tab: Albon's row opens his line-by-line sheet, with
  // his Boost in it, and the Boost has its own section on the page.
  await page.getByRole("tab", { name: "Race" }).click();
  await expect(
    page.getByRole("heading", { name: "Boosts and transfers" }),
  ).toBeVisible();
  await expect(page.getByText("2× Boost · Albon")).toBeVisible();
  const albon = race.getByRole("listitem").filter({ hasText: "Albon" });
  await expect(albon).toContainText("2×");
  await albon.getByRole("button").click();
  const sheet = page.getByRole("dialog");
  await expect(sheet).toContainText("Albon · Race");
  await expect(
    sheet.getByRole("list", { name: "Points, line by line" }),
  ).toContainText("2× Boost");
  await expect(sheet).toContainText("For your team");
  await expectNoSeriousAxeViolations(page);
  await sheet.getByRole("button", { name: "Cancel" }).click();
  await expect(sheet).toHaveCount(0);
});

test("a hidden session shows the cover until revealed, and the title names no result", async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  await withTeam(page);
  await moveClock(request, ROUND_1.afterQualifying);

  // A plain fetch of the page: no score of a hidden session is in it.
  const html = await (
    await page.context().request.get("/team/1/points")
  ).text();
  expect(html).toContain("Qualifying — scores are in");
  expect(html).not.toMatch(/\d+ pts/);

  await page.goto("/team/1/points");
  await expect(page).toHaveTitle(TITLE);
  await expect(page.getByText("Qualifying — scores are in")).toBeVisible();
  await expect(page.getByText(/\d+ pts/)).toHaveCount(0);
  const showIt = page.getByRole("button", { name: "Show it" });
  await hydrated(showIt);
  await showIt.click();
  await expect(
    sessionPoints(page, "Qualifying").getByRole("listitem"),
  ).toHaveCount(7);
  await expect(page.getByText(/\d+ pts/).first()).toBeVisible();
  await expect(page).toHaveTitle(TITLE);

  // Show it isn't stored: a fresh visit covers it again.
  await page.goto("/team/1/points");
  await expect(page.getByText("Qualifying — scores are in")).toBeVisible();
});

test("before any points, the breakdown says so", async ({ page }) => {
  await withTeam(page);
  await page.goto("/team/1/points");
  await expect(
    page.getByRole("heading", { level: 1, name: "No points yet" }),
  ).toBeVisible();
  await expectNoSeriousAxeViolations(page);
});
