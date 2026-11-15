import { expect, test, type Page } from "@playwright/test";
import {
  createAccount,
  expectNoSeriousAxeViolations,
  hydrated,
} from "../helpers/accounts";
import {
  FANTASY_ORIGIN,
  ROUND_1,
  ROUND_2,
  moveClock,
  seedGame,
} from "../helpers/game";
import {
  buildTeam,
  createTeam,
  picker,
  saveButton,
  saveTeam,
  secondDevice,
  teamRow,
} from "../helpers/team";

// The lock and the locked team (M6 Task 9), on the seeded 2026 game at
// phone size. A new account has spoiler protection on, and round 1's
// sessions are inside their 7 days.

test.beforeEach(async ({ page, request }) => {
  await seedGame(request, ROUND_1.beforeLock);
  await createAccount(page.context().request, { origin: FANTASY_ORIGIN });
  await createTeam(page);
  await buildTeam(page);
  await saveTeam(page);
});

const pills = (page: Page) => page.locator('[data-slot="points-pill"]');
const QUALIFYING_HIDDEN = "Qualifying — scores are in";

test("at the lock the builder turns to the locked team and Save is gone", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  // A minute to go (the test clock moves in whole minutes): the countdown
  // runs in seconds, and at zero the page reads itself again.
  const lock = Date.parse(ROUND_1.lock);
  await moveClock(request, new Date(lock - 60_000).toISOString());
  await page.reload();
  await expect(page.getByLabel(/^Locks in 0[01]:\d\d$/)).toBeVisible();
  await hydrated(page.getByRole("button", { name: /^Chips/ }));

  await moveClock(request, ROUND_1.afterLock);
  await expect(page.getByLabel("Your team LOCKED")).toBeVisible({
    timeout: 90_000,
  });
  await expect(saveButton(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Chips/ })).toHaveCount(0);
  // Prices give way to points, and nothing is scored yet.
  await expect(teamRow(page, /Sainz/)).toBeVisible();
  await expect(teamRow(page, /Sainz/)).not.toContainText("$");
  await expect(
    page.getByText("Your points show here after each session."),
  ).toBeVisible();
});

test("after qualifying, the score is hidden; Show it reveals it here only; Mark as watched reveals it everywhere", async ({
  page,
  request,
  browser,
}) => {
  test.setTimeout(180_000);
  await moveClock(request, ROUND_1.afterQualifying);
  await page.reload();
  await expect(page.getByText(QUALIFYING_HIDDEN)).toBeVisible();
  await expect(pills(page)).toHaveCount(0);
  await expect(teamRow(page, /Sainz/)).not.toContainText("pts");

  // Show it: this page only.
  const showIt = page.getByRole("button", { name: "Show it" });
  await hydrated(showIt);
  await showIt.click();
  await expect(page.getByText(QUALIFYING_HIDDEN)).toHaveCount(0);
  await expect(pills(page)).toHaveCount(1);
  await expect(pills(page)).toContainText("Provisional");
  await expect(teamRow(page, /Sainz/)).toContainText("pts");

  const other = await secondDevice(browser, page);
  await other.goto("/team/1");
  await expect(other.getByText(QUALIFYING_HIDDEN)).toBeVisible();
  await expect(pills(other)).toHaveCount(0);

  // Mark as watched: stored, so every page shows it.
  const watched = other.getByRole("button", { name: "Mark as watched" });
  await hydrated(watched);
  await watched.click();
  await expect(pills(other)).toHaveCount(1);
  await other.context().close();

  await page.goto("/team/1");
  await expect(pills(page)).toHaveCount(1);
  await expect(page.getByText(QUALIFYING_HIDDEN)).toHaveCount(0);
});

for (const scheme of ["light", "dark"] as const) {
  test(`axe finds nothing serious on the locked team, ${scheme}`, async ({
    page,
    request,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await moveClock(request, ROUND_1.afterQualifying);
    await page.reload();
    const showIt = page.getByRole("button", { name: "Show it" });
    await hydrated(showIt);
    await expectNoSeriousAxeViolations(page);
    await showIt.click();
    await expect(pills(page)).toHaveCount(1);
    await expectNoSeriousAxeViolations(page);
  });
}

test("Late Call before qualifying says Opens after qualifying; after it, one swap saves and the chip is used", async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  // Late Call is from a team's second race: round 2 here.
  await moveClock(request, ROUND_1.final);
  await moveClock(request, ROUND_2.afterLock);
  await page.reload();
  await expect(page.getByText(/^Round 2 ·/)).toBeVisible();
  await expect(page.getByLabel("Your team LOCKED")).toBeVisible();
  const before = page.getByRole("button", { name: "Play Late Call" });
  await expect(before).toBeDisabled();
  await expect(page.getByText("Opens after qualifying")).toBeVisible();

  await moveClock(request, ROUND_2.afterQualifying);
  await page.reload();
  const open = page.getByRole("button", {
    name: "Play Late Call · swap one driver",
  });
  await hydrated(open);
  await open.click();

  // Who goes out, who comes in, then the confirm step.
  await picker(page)
    .getByRole("list", { name: "Your drivers" })
    .getByRole("button", { name: /Sainz/ })
    .click();
  const drivers = picker(page).getByRole("list", { name: "Drivers" });
  await expect(drivers).toBeVisible();
  const all = picker(page).getByRole("button", { name: /^See all/ });
  if (await all.isVisible()) await all.click();
  await drivers.getByRole("button", { name: /Gasly/ }).click();
  await expect(picker(page)).toContainText(
    /Swap Carlos Sainz for Pierre Gasly/,
  );
  await expect(picker(page)).toContainText("You can't undo this.");
  await picker(page).getByRole("button", { name: "Play Late Call" }).click();

  await expect(
    page.getByRole("status").filter({ hasText: "Late Call played" }),
  ).toBeVisible();
  await expect(teamRow(page, /Gasly/)).toBeVisible();
  await expect(teamRow(page, /Sainz/)).toHaveCount(0);
  await expect(page.getByText("Late Call played.")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^Play Late Call/ }),
  ).toHaveCount(0);
});
