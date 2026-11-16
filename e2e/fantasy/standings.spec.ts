import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";
import {
  createAccount,
  expectNoSeriousAxeViolations,
  heading,
  hydrated,
} from "../helpers/accounts";
import {
  FANTASY_ORIGIN,
  ROUND_1,
  addCrowd,
  moveClock,
  seedGame,
} from "../helpers/game";
import { createLeague } from "../helpers/leagues";
import { buildTeam, createTeam, saveTeam } from "../helpers/team";

// League standings (M6 Task 13), on the seeded 2026 game after round 1's
// race. A new account's spoiler protection is on, so the table stays covered
// until the race is shown or marked as watched.

test.beforeEach(async ({ request }) => {
  await seedGame(request, ROUND_1.beforeLock);
});

/**
 * An account with "Box Box" saved, a private league with it and `crowd`
 * more teams in, scored through round 1's race. Lands on the standings.
 */
async function scoredLeague(
  page: Page,
  request: APIRequestContext,
  crowd: number,
) {
  await createAccount(page.context().request, { origin: FANTASY_ORIGIN });
  await createTeam(page);
  await buildTeam(page);
  await saveTeam(page);
  const code = await createLeague(page, "Monday Night League");
  await addCrowd(request, crowd, code);
  await moveClock(request, ROUND_1.afterRace);
  await page.goto("/leagues");
  await page
    .getByRole("list", { name: "Your leagues" })
    .getByRole("link", { name: /Monday Night League/ })
    .click();
  await expect(heading(page)).toHaveText("Monday Night League");
}

/** Mark as watched on the covered table. */
async function watch(page: Page) {
  const watched = page.getByRole("button", { name: "Mark as watched" });
  await hydrated(watched);
  await watched.click();
}

const list = (page: Page) => page.getByRole("list", { name: "Standings" });

test("a league's standings after round 1 show your team outlined", async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  await scoredLeague(page, request, 3);
  await watch(page);
  await expect(list(page).getByRole("listitem")).toHaveCount(4);
  const mine = list(page).locator("[data-mine]");
  await expect(mine).toHaveCount(1);
  await expect(mine).toContainText("Box Box");
  await expect(mine).toContainText("You");
  await expect(
    page.getByText(/Private · 4 teams · after round 1/),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Teams on the same points are split by who got there first.",
    ),
  ).toBeVisible();
  // My leagues shows the rank now.
  await page.goto("/leagues");
  await expect(page.getByRole("list", { name: "Your leagues" })).toContainText(
    /\d(st|nd|rd|th)/,
  );
});

test("See more loads the next page", async ({ page, request }) => {
  test.setTimeout(240_000);
  // 101 teams in a few groups of shared points (the crowd's Boost moves
  // round five drivers): the first page ends with the group that holds the
  // 50th row.
  await scoredLeague(page, request, 100);
  await watch(page);
  const rows = list(page).getByRole("listitem");
  await expect(rows.first()).toBeVisible();
  const first = await rows.count();
  expect(first).toBeGreaterThanOrEqual(50);
  expect(first).toBeLessThan(101);
  const more = page.getByRole("button", { name: "See more" });
  await more.click();
  await expect(rows).toHaveCount(101);
  await expect(more).toHaveCount(0);
});

test("the table is a real table at desktop width", async ({
  page,
  request,
}) => {
  test.setTimeout(240_000);
  await scoredLeague(page, request, 3);
  await page.setViewportSize({ width: 1280, height: 900 });
  await watch(page);
  const table = page.getByRole("table", { name: "Standings" });
  await expect(table).toBeVisible();
  for (const name of ["Rank", "Team", "Manager", "Last race", "Total"]) {
    await expect(table.getByRole("columnheader", { name })).toBeVisible();
  }
  await expect(table.getByRole("row")).toHaveCount(5);
  await expect(table.getByRole("rowheader", { name: /Box Box/ })).toBeVisible();
  // The phone list is gone, and your place is beside the table.
  await expect(list(page)).toBeHidden();
  await expect(
    page.getByRole("region", { name: "Box Box in this league" }),
  ).toBeVisible();
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expectNoSeriousAxeViolations(page);
  }
});

test("hidden until the race is watched", async ({ page, request }) => {
  test.setTimeout(240_000);
  await scoredLeague(page, request, 3);
  await expect(page.getByText("Round 1 — standings are in")).toBeVisible();
  await expect(list(page)).toHaveCount(0);
  await expect(page.locator("[data-mine]")).toHaveCount(0);

  // Show it: this page only.
  const showIt = page.getByRole("button", { name: "Show it" });
  await hydrated(showIt);
  await showIt.click();
  await expect(page).toHaveURL(/[?&]show=/);
  await expect(list(page).getByRole("listitem")).toHaveCount(4);
  await page.goto(page.url().replace(/\?.*$/, ""));
  await expect(page.getByText("Round 1 — standings are in")).toBeVisible();

  // Mark as watched: every page.
  await watch(page);
  await expect(list(page).getByRole("listitem")).toHaveCount(4);
  await page.reload();
  await expect(list(page).getByRole("listitem")).toHaveCount(4);
});
