import { expect, test } from "@playwright/test";
import { createAccount, pageHydrated } from "../helpers/accounts";
import { setTrust } from "../helpers/forum";
import { FANTASY_ORIGIN, ROUND_1, moveClock, seedGame } from "../helpers/game";

// The spoiler title check (HLD §7.3, M7 Task 6) on the seeded 2026 game:
// Melbourne's qualifying has just started, so a Race Weekend title that
// names a driver and a result is a spoiler for it.

test.beforeEach(async ({ request }) => {
  await seedGame(request, ROUND_1.beforeLock);
  await moveClock(request, ROUND_1.afterLock);
});

test('the spoiler title check offers "Contains spoilers for qualifying"', async ({
  page,
  browser,
}) => {
  const account = await createAccount(page.context().request, {
    origin: FANTASY_ORIGIN,
  });
  await setTrust(page.context().request, account.email, 1);
  await page.goto("/forum/new?category=race-weekend");
  await pageHydrated(page);
  await page.getByLabel("Title").fill("Russell on pole");
  await expect(
    page.getByText("This title may give away a result from this weekend."),
  ).toBeVisible();
  const spoiler = page.getByRole("checkbox", {
    name: "Contains spoilers for qualifying",
  });
  await expect(spoiler).toBeChecked();

  // A title with no result in it brings no warning.
  await page.getByLabel("Title").fill("Russell's long run pace");
  await expect(spoiler).toHaveCount(0);

  await page.getByLabel("Title").fill("Russell on pole");
  await page.getByLabel("Post").fill("Called it on Friday.");
  await page.getByRole("button", { name: "Post thread" }).click();
  await expect(page).toHaveURL(/\/t\/[0-9a-f-]{36}$/);
  // Nobody who hasn't watched sees the title, the author included.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    /^Spoiler thread · .+ qualifying$/,
  );
  await expect(page.getByText("Spoiler protected")).toBeVisible();

  // Logged out, the category shows only the safe title.
  const visitor = await browser.newContext();
  const list = await visitor.newPage();
  await list.goto(`${FANTASY_ORIGIN}/forum/race-weekend`);
  const threads = list.getByRole("list", { name: "Threads" });
  await expect(threads).toContainText("Spoiler thread");
  await expect(threads).toContainText(
    "Title hidden until you’ve watched qualifying",
  );
  await expect(threads).not.toContainText("Russell");
  await visitor.close();
});
