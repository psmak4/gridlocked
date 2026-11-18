import { expect, test, type Page } from "@playwright/test";
import { createAccount, pageHydrated } from "../helpers/accounts";
import { setTrust } from "../helpers/forum";
import { FANTASY_ORIGIN, ROUND_1, moveClock, seedGame } from "../helpers/game";

// Live chat (HLD §7.2, M7 Task 8) on the seeded 2026 game: a minute into
// Melbourne's qualifying, its session thread is in chat mode. The replay
// clock holds still, so the spec moves it on to let slow mode run out.

const later = (iso: string, seconds: number) =>
  new Date(Date.parse(iso) + seconds * 1000).toISOString();

test.beforeEach(async ({ request }) => {
  await seedGame(request, ROUND_1.beforeLock);
  await moveClock(request, ROUND_1.afterLock);
});

/** Opens qualifying's session thread from the Race Weekend list. */
async function openQualifying(page: Page) {
  await page.goto("/forum/race-weekend");
  await page
    .getByRole("list", { name: "Threads" })
    .getByRole("link", { name: /· Qualifying/ })
    .click();
  await expect(page).toHaveURL(/\/t\/[0-9a-f-]{36}$/);
  await pageHydrated(page);
}

test('slow mode shows "Wait 6s" and sends after it', async ({ page }) => {
  test.setTimeout(60_000);
  const account = await createAccount(page.context().request, {
    origin: FANTASY_ORIGIN,
  });
  await setTrust(page.context().request, account.email, 0);
  await openQualifying(page);
  await page.getByRole("button", { name: "Mark as watched" }).click();

  await expect(
    page.getByRole("heading", {
      name: "Live chat · Slow mode: one message every 10 seconds",
    }),
  ).toBeVisible();
  // Chat has its own bar at the bottom, so no bottom nav: the side menu's
  // is the only one left in the page.
  await expect(page.locator('nav[aria-label="Main"]')).toHaveCount(1);

  const message = page.getByRole("textbox", { name: "Message" });
  await expect(message).toHaveAttribute(
    "placeholder",
    "Say something about qualifying",
  );
  await message.fill("Lights out soon");
  await page.getByRole("button", { name: "Send" }).click();
  const log = page.getByRole("log", { name: "Chat messages" });
  await expect(log).toContainText("Lights out soon");

  await message.fill("Purple first sector");
  const wait = page.getByRole("button", { name: /^Wait \d+s$/ });
  await expect(wait).toBeDisabled();
  await expect(page.getByRole("button", { name: "Wait 6s" })).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByRole("status")).toHaveText(
    /^You can send again in \d seconds?\.$/,
  );

  // The server's clock moves past slow mode, and the button comes back.
  await moveClock(page.context().request, later(ROUND_1.afterLock, 60));
  const send = page.getByRole("button", { name: "Send" });
  await expect(send).toBeEnabled({ timeout: 10_000 });
  await send.click();
  await expect(log).toContainText("Purple first sector");
  // Each message once, the refreshes notwithstanding.
  await page.waitForTimeout(3500);
  await expect(log.getByText("Lights out soon")).toHaveCount(1);
});

test("a viewer who hasn't revealed the session never requests /api/chat", async ({
  page,
}) => {
  const chat: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/chat/")) {
      chat.push(request.url());
    }
  });
  await openQualifying(page);
  await expect(page.getByText("Spoiler protected")).toBeVisible();
  // Two refresh windows pass with the cover up.
  await page.waitForTimeout(6500);
  expect(chat).toEqual([]);

  // "Show it" reveals the chat here, and only then does it refresh.
  await page.getByRole("button", { name: "Show it" }).click();
  await expect(
    page
      .getByRole("log", { name: "Chat messages" })
      .or(page.getByText("No messages yet.")),
  ).toBeVisible();
  await expect.poll(() => chat.length).toBeGreaterThan(0);
  await expect(page.getByText("Sign in")).toBeVisible();
});
