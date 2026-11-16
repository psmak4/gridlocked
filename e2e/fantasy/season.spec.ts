import { expect, test, type Page } from "@playwright/test";
import { createAccount, heading, hydrated } from "../helpers/accounts";
import {
  FANTASY_ORIGIN,
  ROUND_1,
  ROUND_2,
  moveClock,
  seedGame,
} from "../helpers/game";
import { createLeague } from "../helpers/leagues";
import {
  buildTeam,
  createTeam,
  picker,
  saveTeam,
  swap,
  teamRow,
} from "../helpers/team";

// M6's exit (Task 15): the roadmap's key tests in one run, one person at
// phone size from sign-up through round 2. Building a team, a chip, joining a
// friend's league, the lock, a hidden qualifying score and Mark as watched,
// the breakdown, standings after the race, prices after the update, round
// 2's transfers, and Late Call after round 2's qualifying. Their spoiler
// protection is on throughout, as for every new account.

const pills = (page: Page) => page.locator('[data-slot="points-pill"]');
const status = (page: Page, text: string) =>
  page.getByRole("status").filter({ hasText: text });

/** Marks the covered sessions on the page as watched. */
async function watch(page: Page) {
  const watched = page.getByRole("button", { name: "Mark as watched" });
  await hydrated(watched);
  await watched.click();
  await expect(watched).toHaveCount(0);
}

test("a season, from sign-up to round 2's Late Call", async ({
  page,
  browser,
  request,
}) => {
  test.setTimeout(900_000);
  await seedGame(request, ROUND_1.beforeLock);

  // A friend runs a league.
  const friendContext = await browser.newContext({
    baseURL: FANTASY_ORIGIN,
    viewport: { width: 390, height: 844 },
  });
  const friend = await friendContext.newPage();
  await createAccount(friend.context().request, { origin: FANTASY_ORIGIN });
  await createTeam(friend);
  await buildTeam(friend);
  await saveTeam(friend);
  const code = await createLeague(friend, "Paddock Pals");
  await friendContext.close();

  // Sign up, then build and save a team: the key test "building a team".
  await createAccount(page.context().request, { origin: FANTASY_ORIGIN });
  await createTeam(page);
  await buildTeam(page);
  await saveTeam(page);

  // The key test "chips": Overdrive on Sainz.
  const chips = page.getByRole("button", { name: /^Chips · \d$/ });
  await hydrated(chips);
  await chips.click();
  await picker(page)
    .getByRole("list", { name: "Chips" })
    .getByRole("button", { name: /^Overdrive/ })
    .click();
  await picker(page)
    .getByRole("list", { name: "Your drivers" })
    .getByRole("button", { name: /Sainz/ })
    .click();
  await picker(page).getByRole("button", { name: "Play Overdrive" }).click();
  await expect(status(page, "Overdrive played")).toBeVisible();
  await expect(teamRow(page, /Sainz/)).toContainText("3×");

  // The key test "joining a league": the friend's code.
  await page.goto("/leagues");
  const join = page.getByRole("button", { name: "Join with a code" });
  await hydrated(join);
  await join.click();
  const sheet = page.getByRole("dialog", { name: "Join a league" });
  await sheet.getByLabel("League code").fill(code.toLowerCase());
  await sheet.getByRole("button", { name: "Join league" }).click();
  await expect(status(page, "You joined Paddock Pals.")).toBeVisible();
  await expect(page.getByRole("list", { name: "Your leagues" })).toContainText(
    "Private · 2 teams",
  );

  // The key test "the lock".
  await moveClock(request, ROUND_1.afterLock);
  await page.goto("/team/1");
  await expect(page.getByLabel("Your team LOCKED")).toBeVisible();

  // The key test "spoiler-gated scores": qualifying is scored but hidden.
  await moveClock(request, ROUND_1.afterQualifying);
  await page.reload();
  await expect(page.getByText("Qualifying — scores are in")).toBeVisible();
  await expect(pills(page)).toHaveCount(0);
  await watch(page);
  await expect(pills(page)).toHaveCount(1);

  // The key test "the breakdown", after the race.
  await moveClock(request, ROUND_1.afterRace);
  await page.goto("/team/1/points");
  await expect(heading(page)).toHaveText("Your points");
  await expect(page.getByText("Race — scores are in")).toBeVisible();
  await watch(page);
  const race = page.getByRole("list", { name: "Race points" });
  await expect(race.getByRole("listitem")).toHaveCount(7);
  await expect(
    race.getByRole("listitem").filter({ hasText: "Sainz" }),
  ).toContainText("3×");

  // Standings after the race: both sessions are watched, so the table shows.
  await page.goto("/leagues");
  await page
    .getByRole("list", { name: "Your leagues" })
    .getByRole("link", { name: /Paddock Pals/ })
    .click();
  await expect(heading(page)).toHaveText("Paddock Pals");
  const table = page.getByRole("list", { name: "Standings" });
  await expect(table.getByRole("listitem")).toHaveCount(2);
  await expect(table.locator("[data-mine]")).toContainText("Box Box");

  // Prices after the update: the race is watched, so the changes show.
  await moveClock(request, ROUND_1.final);
  await page.goto("/prices");
  await expect(heading(page)).toHaveText("Price changes");
  await expect(page.getByText("Round 1 — price changes are in")).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Your team value" }),
  ).toContainText(/since last race\./);

  // Round 2: one transfer.
  await page.goto("/team/1");
  await expect(page.getByText(/^Round 2 ·/)).toBeVisible();
  await hydrated(teamRow(page, /Sainz/).getByRole("button"));
  await expect(page.getByText("0 of 2 free transfers used")).toBeVisible();
  await swap(page, /Sainz/, /Gasly/);
  await expect(page.getByText("1 of 2 free transfers used")).toBeVisible();
  await saveTeam(page);

  // Late Call after round 2's qualifying: one more swap.
  await moveClock(request, ROUND_2.afterLock);
  await moveClock(request, ROUND_2.afterQualifying);
  await page.reload();
  const lateCall = page.getByRole("button", {
    name: "Play Late Call · swap one driver",
  });
  await hydrated(lateCall);
  await lateCall.click();
  await picker(page)
    .getByRole("list", { name: "Your drivers" })
    .getByRole("button", { name: /Alonso/ })
    .click();
  const drivers = picker(page).getByRole("list", { name: "Drivers" });
  await expect(drivers).toBeVisible();
  const all = picker(page).getByRole("button", { name: /^See all/ });
  if (await all.isVisible()) await all.click();
  await drivers.getByRole("button", { name: /Stroll/ }).click();
  await picker(page).getByRole("button", { name: "Play Late Call" }).click();
  await expect(status(page, "Late Call played")).toBeVisible();
  await expect(teamRow(page, /Stroll/)).toBeVisible();
  await expect(teamRow(page, /Alonso/)).toHaveCount(0);
});
