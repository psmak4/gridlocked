import { expect, test, type Page } from "@playwright/test";
import {
  createAccount,
  expectNoSeriousAxeViolations,
  heading,
  hydrated,
} from "../helpers/accounts";
import { FANTASY_ORIGIN, ROUND_1, moveClock, seedGame } from "../helpers/game";
import { buildTeam, createTeam, saveTeam } from "../helpers/team";

// Prices (M6 Task 14) on the seeded 2026 game once round 1 is final and
// round 2 is priced. A new account's spoiler protection is on, and the clock
// is inside round 1's 7-day window, so the changes start covered.

test.beforeEach(async ({ request }) => {
  await seedGame(request, ROUND_1.beforeLock);
});

const COVER = "Round 1 — price changes are in";
const list = (page: Page, name: string) => page.getByRole("list", { name });

test("going up and going down tabs", async ({ page, request }) => {
  test.setTimeout(240_000);
  await createAccount(page.context().request, { origin: FANTASY_ORIGIN });
  await createTeam(page);
  await buildTeam(page);
  await saveTeam(page);
  await moveClock(request, ROUND_1.final);

  await page.goto("/team/1");
  await page.getByRole("link", { name: "Prices", exact: true }).click();
  await expect(page).toHaveURL("/prices");
  await expect(heading(page)).toHaveText("Price changes");
  await expect(page.getByText(/^After round 1 · fixed until/i)).toBeVisible();
  // Covered: no change figures, and the team value's change waits too.
  await expect(page.getByText(COVER)).toBeVisible();
  await expect(page.locator("text=/▲|▼/")).toHaveCount(0);
  const value = page.getByRole("region", { name: "Your team value" });
  await expect(value).toContainText(/\$\d+\.\dM/);
  await expect(value).not.toContainText("since last race");

  const watched = page.getByRole("button", { name: "Mark as watched" });
  await hydrated(watched);
  await watched.click();
  await expect(page.getByText(COVER)).toHaveCount(0);
  await expect(
    list(page, "Going up").getByRole("listitem").first(),
  ).toBeVisible();
  await expect(value).toContainText(
    /(Up|Down) \$\d+\.\dM since last race\.|No change since last race\./,
  );

  await page.getByRole("tab", { name: "Going down" }).click();
  await expect(
    list(page, "Going down").getByRole("listitem").first(),
  ).toBeVisible();
  await expect(list(page, "Going down")).toContainText("▼");
  await page.getByRole("tab", { name: "All" }).click();
  await expect(
    list(page, "All prices").getByRole("listitem").first(),
  ).toBeVisible();
  await expect(list(page, "All prices")).toContainText("Yours");
});

test("How prices work opens from Prices", async ({ page, request }) => {
  await moveClock(request, ROUND_1.final);
  await page.goto("/prices");
  await page.getByRole("link", { name: "How prices work" }).click();
  await expect(page).toHaveURL("/prices/how");
  await expect(heading(page)).toHaveText("How prices work");
  await expect(page.getByText("Example numbers")).toBeVisible();
  const steps = page
    .getByRole("region", { name: "Worked example" })
    .getByRole("listitem");
  await expect(steps).toHaveCount(4);
  await expect(steps.first()).toContainText("Average the last 3 races");
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expectNoSeriousAxeViolations(page);
  }
  await page.getByRole("link", { name: "← Price changes" }).click();
  await expect(page).toHaveURL("/prices");
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expectNoSeriousAxeViolations(page);
  }
});

test("a logged-out visitor gets a public cache header and covered changes", async ({
  page,
  request,
}) => {
  await moveClock(request, ROUND_1.final);
  const response = await page.goto("/prices");
  expect(response!.headers()["cache-control"]).toBe(
    "public, s-maxage=60, stale-while-revalidate=300",
  );
  await expect(page.getByText(COVER)).toBeVisible();
  await expect(page.locator("text=/▲|▼/")).toHaveCount(0);
  // Current prices always show.
  await page.getByRole("tab", { name: "All" }).click();
  await expect(
    list(page, "All prices").getByRole("listitem").first(),
  ).toContainText(/\$\d+\.\dM/);
  await page.getByRole("tab", { name: "Going up" }).click();

  const showIt = page.getByRole("button", { name: "Show it" });
  await hydrated(showIt);
  await showIt.click();
  await expect(page).toHaveURL("/prices?show=changes");
  await expect(list(page, "Going up")).toContainText("▲");
  const shown = await page.request.get("/prices?show=changes");
  expect(shown.headers()["cache-control"]).toBe(
    "public, s-maxage=60, stale-while-revalidate=300",
  );
  // Keyed on the cookie, so a signed-in reader never gets this copy.
  expect(shown.headers()["vary"]).toMatch(/cookie/i);
});

test("public pages are private for a signed-in reader", async ({
  page,
  request,
}) => {
  await moveClock(request, ROUND_1.final);
  const loggedOut = await page.request.get("/prices/how");
  expect(loggedOut.headers()["cache-control"]).toBe(
    "public, s-maxage=60, stale-while-revalidate=300",
  );
  expect(loggedOut.headers()["vary"]).toMatch(/cookie/i);

  // The page carries the account, so it must not reach a shared cache.
  await createAccount(page.context().request, { origin: FANTASY_ORIGIN });
  for (const path of ["/prices/how", "/prices", "/weekend"]) {
    const signedIn = await page.request.get(path);
    expect(signedIn.headers()["cache-control"], path).toBe("private, no-store");
  }
});
