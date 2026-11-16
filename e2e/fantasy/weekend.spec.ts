import { expect, test, type Page } from "@playwright/test";
import {
  createAccount,
  expectNoSeriousAxeViolations,
  hydrated,
} from "../helpers/accounts";
import { FANTASY_ORIGIN, ROUND_1, moveClock, seedGame } from "../helpers/game";
import { buildTeam, createTeam, saveTeam } from "../helpers/team";

// Home and the weekend hub (M6 Task 10), on the seeded 2026 game at phone
// size. Round 1 is Melbourne; a new account's zone is UTC, and its spoiler
// protection is on.

const PUBLIC_CACHE = "public, s-maxage=60, stale-while-revalidate=300";

/** "05:00" for an instant in a zone, as the hub shows it. */
const hhmm = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
  }).format(new Date(iso));

const sessionRow = (page: Page, label: string) =>
  page
    .getByRole("list", { name: "Sessions" })
    .getByRole("listitem")
    .filter({ hasText: new RegExp(`^${label}`, "i") });

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

test("home in race week shows the weekend, the countdown and your season", async ({
  page,
}) => {
  await withTeam(page);
  await page.goto("/");
  const weekend = page.getByRole("link", { name: /^Round 1 ·/ });
  await expect(weekend).toContainText("Australian Grand Prix");
  // An hour to the lock.
  await expect(page.getByLabel(/^Locks in 0[01]:\d\d$/)).toBeVisible();
  const season = page.getByRole("link", { name: "Your season · Box Box" });
  await expect(season).toContainText(
    "Your points show here after your first race.",
  );
  await expect(season).toHaveAttribute("href", "/team/1");

  await weekend.click();
  await expect(page).toHaveURL("/weekend");
  await expect(
    page.getByRole("heading", { level: 1, name: "Australian Grand Prix" }),
  ).toBeVisible();
});

test("the hub switches between your time and track time", async ({ page }) => {
  await withTeam(page);
  await page.goto("/weekend");
  await expect(page.getByLabel(/^Your team locks in /)).toBeVisible();
  const qualifying = sessionRow(page, "Qualifying");
  await expect(qualifying).toContainText("Locks team");
  await expect(qualifying).toContainText("your team locks at the start");
  await expect(sessionRow(page, "Race")).not.toContainText("Locks team");

  // The profile's zone, UTC, then the circuit's.
  await expect(qualifying).toContainText(hhmm(ROUND_1.lock, "UTC"));
  const track = page.getByRole("tab", { name: "Track" });
  await hydrated(track);
  await track.click();
  await expect(qualifying).toContainText(
    hhmm(ROUND_1.lock, "Australia/Melbourne"),
  );
  await expect(page.getByLabel(/^Your team locks in /)).toContainText(
    "track time",
  );
  await page.getByRole("tab", { name: "My time" }).click();
  await expect(qualifying).toContainText(hhmm(ROUND_1.lock, "UTC"));

  // Signed in, the hub carries the viewer's watched state: private.
  const response = await page.context().request.get("/weekend");
  expect(response.headers()["cache-control"]).toBe("private, no-store");
});

test("a logged-out visitor sees the hub, with a public cache header and no cookie", async ({
  browser,
  playwright,
}) => {
  const anonymous = await playwright.request.newContext({
    baseURL: FANTASY_ORIGIN,
  });
  const response = await anonymous.get("/weekend");
  expect(response.status()).toBe(200);
  expect(response.headers()["cache-control"]).toBe(PUBLIC_CACHE);
  expect(response.headers()["set-cookie"]).toBeUndefined();
  expect(await response.text()).toContain("Australian Grand Prix");
  await anonymous.dispose();

  const context = await browser.newContext({
    baseURL: FANTASY_ORIGIN,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  await page.goto("/");
  await page.getByRole("link", { name: "See this weekend" }).click();
  await expect(page).toHaveURL("/weekend");
  await expect(
    page.getByRole("heading", { level: 1, name: "Australian Grand Prix" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Build a team" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Mark as watched" }),
  ).toHaveCount(0);
  await context.close();
});

test("Mark as watched on the hub reveals the score on the team page", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  await withTeam(page);
  await moveClock(request, ROUND_1.afterQualifying);

  // Home covers the season: it includes qualifying, which isn't watched.
  await page.goto("/");
  await expect(page.getByText(/— standings are in$/)).toBeVisible();
  await expect(page.getByText(/\d pts$/)).toHaveCount(0);

  await page.goto("/weekend");
  const qualifying = sessionRow(page, "Qualifying");
  await expect(qualifying).toContainText(
    "Results are in · hidden until you watch",
  );
  await expect(qualifying).toContainText("Hidden");
  await expect(
    page.getByText("Spoiler protection is on.", { exact: false }),
  ).toBeVisible();
  const watched = qualifying.getByRole("button", { name: "Mark as watched" });
  await hydrated(watched);
  await watched.click();
  await expect(qualifying).not.toContainText("Hidden");
  await expect(qualifying).toContainText("results are in");
  await expect(watched).toHaveCount(0);

  // Stored, so the team page and Home show it too.
  await page.goto("/team/1");
  await expect(page.getByText("Qualifying — scores are in")).toHaveCount(0);
  await expect(page.locator('[data-slot="points-pill"]')).toHaveCount(1);
  await page.goto("/");
  await expect(page.getByText(/— standings are in$/)).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Your season · Box Box" }),
  ).toContainText(/Global \d+(st|nd|rd|th) of \d/);
});

for (const scheme of ["light", "dark"] as const) {
  test(`axe finds nothing serious on home and the hub, ${scheme}`, async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    await page.emulateMedia({ colorScheme: scheme });
    await withTeam(page);
    await moveClock(request, ROUND_1.afterQualifying);
    await page.goto("/");
    await hydrated(page.getByRole("button", { name: "Show it" }));
    await expectNoSeriousAxeViolations(page);
    await page.goto("/weekend");
    await hydrated(page.getByRole("button", { name: "Mark as watched" }));
    await expectNoSeriousAxeViolations(page);
  });
}
