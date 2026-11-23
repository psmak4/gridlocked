import { expect, test, type Page } from "@playwright/test";
import { createAccount, hydrated } from "../helpers/accounts";
import { FANTASY_ORIGIN, ROUND_1, moveClock, seedGame } from "../helpers/game";
import { buildTeam, createTeam, saveTeam } from "../helpers/team";

// "Show it" reveals for this page only (M9 Task 4): the reveal is kept in
// the history entry, so back and forward keep it and a copied address
// doesn't carry it.

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

test.beforeEach(async ({ page, request }) => {
  test.setTimeout(240_000);
  await seedGame(request, ROUND_1.beforeLock);
  await createAccount(page.context().request, { origin: FANTASY_ORIGIN });
  await createTeam(page);
  await buildTeam(page);
  await saveTeam(page);
  await moveClock(request, ROUND_1.afterRace);
});

const covered = (page: Page) => page.getByText("Race — scores are in");
const racePoints = (page: Page) =>
  page.getByRole("list", { name: "Race points" });

/** Show it on the race, and the session id the page asked to see. */
async function showRace(page: Page): Promise<string> {
  await page.goto("/team/1/points");
  await expect(covered(page)).toBeVisible();
  const showIt = page.getByRole("button", { name: "Show it" });
  await hydrated(showIt);
  const asked = page.waitForRequest((r) =>
    UUID.test(decodeURIComponent(r.url())),
  );
  await showIt.click();
  await expect(racePoints(page).getByRole("listitem")).toHaveCount(7);
  return decodeURIComponent((await asked).url()).match(UUID)![0];
}

test("a revealed score isn't revealed for someone who opens the copied address", async ({
  page,
}) => {
  await showRace(page);
  await expect(page).toHaveURL(/\/team\/1\/points$/);

  // A reload, and back and forward, keep it.
  await page.reload();
  await expect(racePoints(page).getByRole("listitem")).toHaveCount(7);
  await page.goto("/team/1");
  await page.goBack();
  await expect(racePoints(page).getByRole("listitem")).toHaveCount(7);

  // The copied address, opened fresh, is covered.
  const copy = await page.context().newPage();
  await copy.goto(page.url());
  await expect(covered(copy)).toBeVisible();
  await expect(racePoints(copy)).toHaveCount(0);
});

test("an old ?show= link reveals once and leaves the address without it", async ({
  page,
}) => {
  const raceId = await showRace(page);
  const old = await page.context().newPage();
  await old.goto(`/team/1/points?show=${raceId}`);
  await expect(racePoints(old).getByRole("listitem")).toHaveCount(7);
  await expect(old).toHaveURL(/\/team\/1\/points$/);
  // Its address no longer reveals.
  const again = await page.context().newPage();
  await again.goto(old.url());
  await expect(covered(again)).toBeVisible();
});
