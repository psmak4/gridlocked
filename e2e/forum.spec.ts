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

test("edit, then delete, your own comment", async ({ page, browser }) => {
  const author = await createAccount(page.context().request);
  await setTrust(page.context().request, author.email, 1);
  await page.goto("/forum/new?category=general");
  await pageHydrated(page);
  await page.getByLabel("Title").fill("Best overtake of the season?");
  await page.getByLabel("Post").fill("Mine is Turn 1 in Austin.");
  await page.getByRole("button", { name: "Post thread" }).click();
  await expect(page).toHaveURL(/\/t\/[0-9a-f-]{36}$/);
  const threadUrl = page.url();

  const other = await browser.newContext();
  const writer = await other.newPage();
  const account = await createAccount(other.request);
  await setTrust(other.request, account.email, 0);
  await writer.goto(threadUrl);
  await pageHydrated(writer);
  await writer.getByLabel("Add a comment").fill("Hamilton at Silverstne.");
  await writer.getByRole("button", { name: "Post comment" }).click();
  const comments = writer.getByRole("list", { name: "Comments" });
  await expect(comments).toContainText("Hamilton at Silverstne.");

  // Your own comment's "…" has Edit and Delete, and no Report.
  const more = comments.getByRole("button", { name: "More for your post" });
  await more.click();
  await expect(writer.getByRole("menuitem", { name: "Report" })).toHaveCount(0);
  await writer.getByRole("menuitem", { name: "Edit" }).click();
  const box = comments.getByLabel("Edit your post");
  await expect(box).toHaveValue("Hamilton at Silverstne.");
  await box.fill("Hamilton at Silverstone.");
  await comments.getByRole("button", { name: "Save" }).click();
  await expect(comments).toContainText("Hamilton at Silverstone.");
  await expect(comments).toContainText("edited");
  await expectNoSeriousAxeViolations(writer);

  await more.click();
  await writer.getByRole("menuitem", { name: "Delete" }).click();
  await comments.getByRole("button", { name: "Delete post" }).click();
  // With no replies under it, a deleted comment leaves nothing behind.
  await expect(writer.getByText("Hamilton at Silverstone.")).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("Hamilton at Silverstone.")).toHaveCount(0);
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

test('report a post from the "…" menu', async ({ page, browser }) => {
  // The author starts a thread and comments on it.
  const author = await createAccount(page.context().request);
  await setTrust(page.context().request, author.email, 1);
  await page.goto("/forum/new?category=general");
  await pageHydrated(page);
  await page.getByLabel("Title").fill("Who wins in Baku?");
  await page.getByLabel("Post").fill("Street circuits are a lottery.");
  await page.getByRole("button", { name: "Post thread" }).click();
  await expect(page).toHaveURL(/\/t\/[0-9a-f-]{36}$/);
  const threadUrl = page.url();
  await page.getByLabel("Add a comment").fill("Buy cheap tickets here");
  await page.getByRole("button", { name: "Post comment" }).click();
  const comments = page.getByRole("list", { name: "Comments" });
  await expect(comments).toContainText("Buy cheap tickets here");
  // Nobody reports their own post.
  await expect(
    comments.getByRole("button", { name: /^More for the post/ }),
  ).toHaveCount(0);

  // A TL3 regular reports the comment: their report alone hides it.
  const other = await browser.newContext();
  const reader = await other.newPage();
  const regular = await createAccount(other.request);
  await setTrust(other.request, regular.email, 3);
  await reader.goto(threadUrl);
  await pageHydrated(reader);
  const more = reader
    .getByRole("list", { name: "Comments" })
    .getByRole("button", { name: `More for the post by ${author.username}` });
  await hydrated(more);
  await more.click();
  await reader.getByRole("menuitem", { name: "Report" }).click();
  const sheet = reader.getByRole("dialog", { name: "Report" });
  await expect(sheet).toContainText(
    `Reporting the post by ${author.username}.`,
  );
  const send = sheet.getByRole("button", { name: "Send report" });
  await expect(send).toBeDisabled();
  await sheet.getByRole("radio", { name: "Spam" }).check();
  await sheet.getByLabel("Anything else? (optional)").fill("Ticket spam.");
  await send.click();
  await expect(sheet.getByRole("status")).toHaveText(
    "Thanks. A moderator will take a look.",
  );
  await sheet.getByRole("button", { name: "Done" }).click();
  await expect(sheet).toHaveCount(0);

  // It's hidden pending review.
  await reader.reload();
  await expect(reader.getByRole("list", { name: "Comments" })).toHaveCount(0);
  await expect(reader.getByText("Buy cheap tickets here")).toHaveCount(0);
  await other.close();
});

test("a logged-out visitor reports with an email address", async ({
  page,
  browser,
}) => {
  const author = await createAccount(page.context().request);
  await setTrust(page.context().request, author.email, 1);
  await page.goto("/forum/new?category=general");
  await pageHydrated(page);
  await page.getByLabel("Title").fill("Pit stop records");
  await page.getByLabel("Post").fill("Under two seconds now.");
  await page.getByRole("button", { name: "Post thread" }).click();
  await expect(page).toHaveURL(/\/t\/[0-9a-f-]{36}$/);
  const threadUrl = page.url();

  const visitor = await browser.newContext();
  const reader = await visitor.newPage();
  await reader.goto(threadUrl);
  await pageHydrated(reader);
  const more = reader.getByRole("button", {
    name: `More for the post by ${author.username}`,
  });
  await hydrated(more);
  await more.click();
  await reader.getByRole("menuitem", { name: "Report" }).click();
  const sheet = reader.getByRole("dialog", { name: "Report" });
  await expect(sheet).toContainText("Reporting this thread.");
  await sheet.getByRole("radio", { name: "Copyright infringement" }).check();
  const send = sheet.getByRole("button", { name: "Send report" });
  await expect(send).toBeDisabled();
  await sheet.getByLabel("Your email").fill("reporter@example.test");
  await send.click();
  await expect(sheet.getByRole("status")).toHaveText(
    "Thanks. A moderator will take a look.",
  );
  await visitor.close();
});
