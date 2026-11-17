import { expect, test, type Browser, type Page } from "@playwright/test";
import { createAccount, pageHydrated } from "../helpers/accounts";
import { setTrust } from "../helpers/forum";
import { FANTASY_ORIGIN, ROUND_1, moveClock, seedGame } from "../helpers/game";

// Logged-out spoiler safety (HLD §7.3, M7 Task 10) on the seeded 2026 game:
// Melbourne's qualifying has just started, so a thread about it is hidden
// from a visitor until their device is set to show results.

const TITLE = "Russell on pole";
const BODY = "Called it on Friday.";

test.beforeEach(async ({ request }) => {
  await seedGame(request, ROUND_1.beforeLock);
  await moveClock(request, ROUND_1.afterLock);
});

/** A TL1 member posts a qualifying spoiler; returns its address. */
async function postSpoiler(page: Page): Promise<string> {
  const account = await createAccount(page.context().request, {
    origin: FANTASY_ORIGIN,
  });
  await setTrust(page.context().request, account.email, 1);
  await page.goto("/forum/new?category=race-weekend");
  await pageHydrated(page);
  await page.getByLabel("Title").fill(TITLE);
  await page.getByLabel("Post").fill(BODY);
  await page.getByRole("button", { name: "Post thread" }).click();
  await expect(page).toHaveURL(/\/t\/[0-9a-f-]{36}$/);
  return new URL(page.url()).pathname;
}

async function visitor(browser: Browser) {
  const context = await browser.newContext({ baseURL: FANTASY_ORIGIN });
  return { context, page: await context.newPage() };
}

test("a race thread inside its window shows the safe title and no posts", async ({
  page,
  browser,
}) => {
  const path = await postSpoiler(page);
  const { context, page: visit } = await visitor(browser);
  await visit.goto(path);
  await expect(visit.getByRole("heading", { level: 1 })).toHaveText(
    /^Spoiler thread · .+ qualifying$/,
  );
  await expect(visit.getByText("Spoiler protected")).toBeVisible();
  await expect(visit.getByText(BODY)).toHaveCount(0);
  await expect(
    visit.getByRole("switch", {
      name: "Show results everywhere on this device",
    }),
  ).not.toBeChecked();

  // The default thread page's HTML contains no post text, and no title.
  const html = await (await context.request.get(path)).text();
  expect(html).not.toContain(BODY);
  expect(html).not.toContain(TITLE);
  await context.close();
});

test("turning the toggle on shows them, and it survives a reload", async ({
  page,
  browser,
}) => {
  const path = await postSpoiler(page);
  const { context, page: visit } = await visitor(browser);
  await visit.goto(path);
  await pageHydrated(visit);
  const toggle = visit.getByRole("switch", {
    name: "Show results everywhere on this device",
  });
  await toggle.click();
  await expect(visit.getByRole("heading", { level: 1 })).toHaveText(TITLE);
  await expect(visit.getByText(BODY)).toBeVisible();
  await expect(visit).toHaveURL(/[?&]show=all/);

  await visit.reload();
  await expect(visit.getByText(BODY)).toBeVisible();
  // The plain address, on this device, asks for the shown one.
  await visit.goto(path);
  await expect(visit).toHaveURL(/[?&]show=all/);
  await expect(visit.getByText(BODY)).toBeVisible();
  // And the list shows the real title too.
  await visit.goto("/forum/race-weekend");
  await expect(visit).toHaveURL(/[?&]show=all/);
  await expect(visit.getByRole("list", { name: "Threads" })).toContainText(
    TITLE,
  );

  // Off again: hidden, and the plain address stays plain.
  await visit.goto(path);
  await pageHydrated(visit);
  await toggle.click();
  await expect(visit.getByText("Spoiler protected")).toBeVisible();
  await visit.goto(path);
  await pageHydrated(visit);
  await expect(visit.getByText("Spoiler protected")).toBeVisible();
  await expect(visit).not.toHaveURL(/show=all/);
  await context.close();
});

test("chat isn't requested until revealed", async ({ browser }) => {
  const { context, page: visit } = await visitor(browser);
  const chat: string[] = [];
  visit.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/chat/")) {
      chat.push(request.url());
    }
  });
  await visit.goto("/forum/race-weekend");
  await visit
    .getByRole("list", { name: "Threads" })
    .getByRole("link", { name: /· Qualifying/ })
    .click();
  await pageHydrated(visit);
  await expect(visit.getByText("Spoiler protected")).toBeVisible();
  await visit.waitForTimeout(3500);
  expect(chat).toEqual([]);

  await visit
    .getByRole("switch", { name: "Show results everywhere on this device" })
    .click();
  await expect(
    visit.getByText("New messages appear every few seconds."),
  ).toBeVisible();
  await expect.poll(() => chat.length).toBeGreaterThan(0);
  await context.close();
});
