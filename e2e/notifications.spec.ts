import {
  expect,
  test,
  type Browser,
  type BrowserContext,
} from "@playwright/test";
import {
  createAccount,
  expectNoSeriousAxeViolations,
  pageHydrated,
} from "./helpers/accounts";
import { setTrust } from "./helpers/forum";

// The bell and its list (M7 Task 13), at phone size: replies in one thread
// are one row, and opening a row or "Mark all as read" clears the count.

/** Someone new and verified, in a context of their own. */
async function someone(browser: Browser) {
  const context = await browser.newContext();
  const account = await createAccount(context.request);
  await setTrust(context.request, account.email, 0);
  return { context, account };
}

async function replyIn(context: BrowserContext, url: string, body: string) {
  const page = await context.newPage();
  await page.goto(url);
  await pageHydrated(page);
  await page.getByLabel("Add a comment").fill(body);
  await page.getByRole("button", { name: "Post comment" }).click();
  await expect(page.getByRole("list", { name: "Comments" })).toContainText(
    body,
  );
  await page.close();
}

test("the bell shows 3, the list groups replies, opening it clears the count", async ({
  page,
  browser,
}) => {
  const author = await createAccount(page.context().request);
  await setTrust(page.context().request, author.email, 1);

  async function startThread(title: string, body: string) {
    await page.goto("/forum/new?category=general");
    await pageHydrated(page);
    await page.getByLabel("Title").fill(title);
    await page.getByLabel("Post").fill(body);
    await page.getByRole("button", { name: "Post thread" }).click();
    await expect(page).toHaveURL(/\/t\/[0-9a-f-]{36}$/);
    return page.url();
  }
  const pits = await startThread("Pit windows at Monaco", "When do you stop?");
  const tyres = await startThread("Tyres for Silverstone", "Which compound?");

  const first = await someone(browser);
  const second = await someone(browser);
  // Two replies in one thread: one row, "2 new replies".
  await replyIn(first.context, pits, "Lap 30 or so.");
  await replyIn(second.context, pits, "Earlier, under a safety car.");
  // A mention, and a reply in another thread.
  await replyIn(
    first.context,
    tyres,
    `Mediums, @${author.username}, then hards.`,
  );
  await replyIn(second.context, tyres, "Softs to start.");

  await page.goto("/forum");
  await pageHydrated(page);
  const bell = page.getByRole("link", { name: "Notifications, 3 unread" });
  await expect(bell).toBeVisible();
  await bell.click();

  await expect(page).toHaveURL(/\/notifications$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Notifications",
  );
  const list = page.getByRole("list", { name: "Notifications" });
  await expect(list.getByRole("listitem")).toHaveCount(3);
  await expect(list).toContainText("2 new replies in “Pit windows at Monaco”");
  await expect(list).toContainText(
    `${first.account.username} mentioned you in “Tyres for Silverstone”`,
  );
  await expect(list).toContainText(
    `${second.account.username} replied in “Tyres for Silverstone”`,
  );
  await expect(
    page.getByText("That's everything from the last 90 days."),
  ).toBeVisible();
  await expectNoSeriousAxeViolations(page);

  // Opening one goes to the thread and marks it read.
  await pageHydrated(page);
  await list.getByRole("link", { name: /2 new replies/ }).click();
  await expect(page).toHaveURL(/\/t\/[0-9a-f-]{36}/);
  await page.goto("/forum");
  await expect(
    page.getByRole("link", { name: "Notifications, 2 unread" }),
  ).toBeVisible();

  await page.goto("/notifications");
  await pageHydrated(page);
  await page.getByRole("button", { name: "Mark all as read" }).click();
  await expect(
    page.getByRole("button", { name: "Mark all as read" }),
  ).toHaveCount(0);
  await page.goto("/forum");
  await expect(
    page.getByRole("link", { name: "Notifications", exact: true }),
  ).toBeVisible();

  await first.context.close();
  await second.context.close();
});

test("a logged-out visitor is sent to sign in first", async ({ page }) => {
  await page.goto("/notifications");
  await expect(page).toHaveURL(/\/sign-in\?next=(%2F|\/)notifications$/);
});
