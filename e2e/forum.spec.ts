import { expect, test } from "@playwright/test";
import {
  createAccount,
  expectNoSeriousAxeViolations,
  hydrated,
  pageHydrated,
} from "./helpers/accounts";
import { setTrust } from "./helpers/forum";

// The forum's screens (M7 Task 6), at phone size: reading is public, a TL1
// account starts a thread, and anyone verified replies and votes.

const PUBLIC_CACHE = "public, s-maxage=60, stale-while-revalidate=300";

test("the forum is public, cacheable and lists the seven categories", async ({
  page,
}) => {
  const response = await page.goto("/forum");
  expect(response?.headers()["cache-control"]).toBe(PUBLIC_CACHE);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Forum");
  const categories = page.getByRole("list", { name: "Categories" });
  await expect(categories.getByRole("listitem")).toHaveCount(7);
  await expect(categories.getByRole("link").first()).toContainText(
    "Race Weekend",
  );
  // Logged out, nobody offers to start a thread.
  await expect(page.getByRole("link", { name: "New thread" })).toHaveCount(0);
  await expectNoSeriousAxeViolations(page);
});

test("post a reply and vote on it", async ({ page, browser }) => {
  // The author: TL1, so they can start a thread.
  const author = await createAccount(page.context().request);
  await setTrust(page.context().request, author.email, 1);
  await page.goto("/forum/general");
  await page.getByRole("link", { name: "New thread" }).click();
  await expect(page).toHaveURL(/\/forum\/new\?category=general$/);
  await pageHydrated(page);
  await page.getByLabel("Title").fill("One stop or two at Monaco?");
  await page.getByLabel("Post").fill("Tyres last forever there.");
  await page.getByRole("button", { name: "Post thread" }).click();
  await expect(page).toHaveURL(/\/t\/[0-9a-f-]{36}$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "One stop or two at Monaco?",
  );
  const threadUrl = page.url();

  // Someone else, TL0: they can reply and upvote.
  const other = await browser.newContext();
  const reader = await other.newPage();
  const account = await createAccount(other.request);
  await setTrust(other.request, account.email, 0);
  await reader.goto(threadUrl);
  await pageHydrated(reader);
  await reader.getByLabel("Add a comment").fill("One, on hards.");
  await reader.getByRole("button", { name: "Post comment" }).click();
  const comments = reader.getByRole("list", { name: "Comments" });
  await expect(comments.getByRole("article")).toHaveCount(1);
  await expect(comments).toContainText("One, on hards.");
  await expect(comments).toContainText(account.username);

  const opening = reader.getByRole("article", {
    name: `Post by ${author.username}`,
  });
  const upvote = opening.getByRole("button", { name: "Upvote" });
  await hydrated(upvote);
  await upvote.click();
  await expect(upvote).toHaveAttribute("aria-pressed", "true");
  await expect(opening.locator("[data-score]")).toHaveText("1");
  // TL0 can't downvote, so there is no button for it.
  await expect(opening.getByRole("button", { name: "Downvote" })).toHaveCount(
    0,
  );

  // The vote is kept.
  await reader.reload();
  await expect(opening.locator("[data-score]")).toHaveText("1");
  await expect(opening.getByRole("button", { name: "Upvote" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // The author sees the reply in the category's count.
  await page.goto("/forum/general");
  await expect(
    page.getByRole("link", { name: /One stop or two at Monaco\?/ }),
  ).toContainText("1 reply");
  await expectNoSeriousAxeViolations(reader);
  await other.close();
});

test('a TL0 viewer sees no "New thread"', async ({ page }) => {
  const account = await createAccount(page.context().request);
  await setTrust(page.context().request, account.email, 0);
  for (const path of ["/forum", "/forum/general"]) {
    const response = await page.goto(path);
    // Signed in, the page is theirs alone.
    expect(response?.headers()["cache-control"]).toBe("private, no-store");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("link", { name: "New thread" })).toHaveCount(0);
  }
  await page.goto("/forum/new");
  await expect(
    page.getByRole("heading", { name: "You can't start threads yet" }),
  ).toBeVisible();
});

test("starting a thread needs an account", async ({ page }) => {
  await page.goto("/forum/new?category=fantasy");
  await expect(page).toHaveURL(/\/sign-in\?next=/);
});
