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
  swap,
  teamRow,
} from "../helpers/team";

// The chip sheet (M6 Task 9), on the seeded 2026 game at phone size. Our
// own prices are listed in ../helpers/team.ts.

test.beforeEach(async ({ page, request }) => {
  await seedGame(request, ROUND_1.beforeLock);
  await createAccount(page.context().request, { origin: FANTASY_ORIGIN });
});

const chipsButton = (page: Page) =>
  page.getByRole("button", { name: /^Chips · \d$/ });

/** Opens the chip sheet. */
async function openChips(page: Page) {
  await hydrated(chipsButton(page));
  await chipsButton(page).click();
  await expect(picker(page).getByRole("list", { name: "Chips" })).toBeVisible();
}

const chipRow = (page: Page, name: string) =>
  picker(page)
    .getByRole("list", { name: "Chips" })
    .getByRole("button", { name: new RegExp(`^${name}`) });

/** Plays a chip that takes no driver, from its row to its confirm step. */
async function play(page: Page, name: string) {
  await chipRow(page, name).click();
  await expect(picker(page)).toContainText("You can't undo this.");
  await picker(page)
    .getByRole("button", { name: `Play ${name}` })
    .click();
}

const toast = (page: Page, text: string) =>
  page.getByRole("status").filter({ hasText: text });

test("play Overdrive on a driver, see it on the team, and see it can't be played again", async ({
  page,
}) => {
  await createTeam(page);
  await buildTeam(page);
  await saveTeam(page);
  await expect(chipsButton(page)).toHaveText("Chips · 6");
  await openChips(page);

  await chipRow(page, "Overdrive").click();
  const drivers = picker(page).getByRole("list", { name: "Your drivers" });
  await drivers.getByRole("button", { name: /Sainz/ }).click();
  await expect(picker(page)).toContainText("On Carlos Sainz.");
  await expect(picker(page)).toContainText("You can't undo this.");
  await picker(page).getByRole("button", { name: "Play Overdrive" }).click();

  await expect(toast(page, "Overdrive played")).toBeVisible();
  await expect(teamRow(page, /Sainz/)).toContainText("3×");
  await expect(
    page.getByText("Overdrive is played for this race."),
  ).toBeVisible();
  await expect(chipsButton(page)).toHaveText("Chips · 5");

  await openChips(page);
  await expect(chipRow(page, "Overdrive")).toBeDisabled();
  await expect(chipRow(page, "Overdrive")).toContainText("Played");
  await expect(chipRow(page, "Safety Car")).toContainText("One per race");
  // Still played after a reload.
  await page.reload();
  await expect(teamRow(page, /Sainz/)).toContainText("3×");
});

test("Overdrive can't go on the Boost driver", async ({ page }) => {
  await createTeam(page);
  await buildTeam(page);
  await saveTeam(page);
  await openChips(page);
  await chipRow(page, "Overdrive").click();

  const albon = picker(page)
    .getByRole("list", { name: "Your drivers" })
    .getByRole("button", { name: /Albon/ });
  await expect(albon).toBeDisabled();
  await expect(albon).toContainText("Has your 2× Boost");
  await albon.click({ force: true });
  await expect(picker(page)).not.toContainText("You can't undo this.");
});

test("Overdrive waits for a saved team", async ({ page }) => {
  await createTeam(page);
  await buildTeam(page);
  // Not saved yet: Overdrive goes on the team as saved.
  await openChips(page);
  await expect(chipRow(page, "Overdrive")).toBeDisabled();
  await expect(chipRow(page, "Overdrive")).toContainText(
    "Save your team first",
  );
});

test("Rebuild says From your second race in round 1", async ({ page }) => {
  await createTeam(page);
  await openChips(page);
  for (const name of ["Rebuild", "Blank Cheque", "Late Call"]) {
    await expect(chipRow(page, name)).toBeDisabled();
    await expect(chipRow(page, name)).toContainText("From your second race");
  }
  await expect(chipRow(page, "Strategist")).toBeEnabled();
});

test("Blank Cheque lets a team over the cap save, and next round it's back to the old team", async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  await createTeam(page);
  await buildTeam(page);
  await saveTeam(page);

  await moveClock(request, ROUND_1.final);
  await page.reload();
  await expect(page.getByText(/^Round 2 ·/)).toBeVisible();
  await openChips(page);
  await play(page, "Blank Cheque");
  await expect(toast(page, "Blank Cheque played")).toBeVisible();
  await expect(page.getByText("Blank Cheque: no cap this race.")).toBeVisible();

  // Three of the dearest drivers: far over $100M.
  await swap(page, /Sainz/, /Norris/);
  await swap(page, /Alonso/, /Verstappen/);
  await swap(page, /Hülkenberg/, /Piastri/);
  await saveButton(page).click();
  await expect(toast(page, "Team saved")).toBeVisible();

  // Round 2 done: round 3 starts from the team before the Blank Cheque.
  await moveClock(request, ROUND_2.final);
  await page.reload();
  await expect(page.getByText(/^Round 3 ·/)).toBeVisible();
  await expect(teamRow(page, /Sainz/)).toBeVisible();
  await expect(teamRow(page, /Alonso/)).toBeVisible();
  await expect(teamRow(page, /Norris/)).toHaveCount(0);
  await openChips(page);
  await expect(chipRow(page, "Blank Cheque")).toContainText("Used in");
});

test("a second chip in the same round is refused with words", async ({
  page,
  browser,
}) => {
  await createTeam(page);
  await buildTeam(page);
  await saveTeam(page);
  await openChips(page);

  // Another device plays Strategist while this sheet is open.
  const other = await secondDevice(browser, page);
  await other.goto("/team/1");
  await openChips(other);
  await play(other, "Strategist");
  await expect(toast(other, "Strategist played")).toBeVisible();
  await other.context().close();

  await play(page, "Safety Car");
  await expect(picker(page).getByRole("alert")).toHaveText(
    "That chip can't be played. Each chip works once a season, one per race.",
  );
  // The sheet reads the chips again.
  await expect(chipRow(page, "Strategist")).toContainText("Played");
  await expect(chipRow(page, "Safety Car")).toContainText("One per race");
});

for (const scheme of ["light", "dark"] as const) {
  test(`axe finds nothing serious on the chip sheet, ${scheme}`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await createTeam(page);
    await buildTeam(page);
    await saveTeam(page);
    await openChips(page);
    await expectNoSeriousAxeViolations(page);
    await chipRow(page, "Overdrive").click();
    await expectNoSeriousAxeViolations(page);
  });
}
