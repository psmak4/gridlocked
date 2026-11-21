import { expect, test, type Browser } from "@playwright/test";
import {
  createAccount,
  expectNoSeriousAxeViolations,
  heading,
  hydrated,
  ownAddress,
  pageHydrated,
} from "./helpers/accounts";
import { setTrust } from "./helpers/forum";
import { unlockedAdmin } from "./helpers/staff";

// The moderation queue (M8 Task 11): a reader reports a post, a moderator
// removes it with a note, and the author sees the note on their profile.

test.beforeEach(async ({ page }) => {
  await ownAddress(page);
});

/** An author's thread with one comment, reported by a newcomer as spam. */
async function reportedComment(browser: Browser, words: string) {
  const authorContext = await browser.newContext();
  const page = await authorContext.newPage();
  const author = await createAccount(authorContext.request);
  await setTrust(authorContext.request, author.email, 1);
  await page.goto("/forum/new?category=general");
  await pageHydrated(page);
  await page.getByLabel("Title").fill("Pit stop strategy");
  await page.getByLabel("Post").fill("Two stops, surely.");
  await page.getByRole("button", { name: "Post thread" }).click();
  await expect(page).toHaveURL(/\/t\/[0-9a-f-]{36}$/);
  const threadUrl = page.url();
  await page.getByLabel("Add a comment").fill(words);
  await page.getByRole("button", { name: "Post comment" }).click();
  await expect(page.getByRole("list", { name: "Comments" })).toContainText(
    words,
  );

  const readerContext = await browser.newContext();
  const reader = await readerContext.newPage();
  const newcomer = await createAccount(readerContext.request);
  await setTrust(readerContext.request, newcomer.email, 0);
  await reader.goto(threadUrl);
  await pageHydrated(reader);
  const more = reader
    .getByRole("list", { name: "Comments" })
    .getByRole("button", { name: `More for the post by ${author.username}` });
  await hydrated(more);
  await more.click();
  await reader.getByRole("menuitem", { name: "Report" }).click();
  const sheet = reader.getByRole("dialog", { name: "Report" });
  await sheet.getByRole("radio", { name: "Spam" }).check();
  await sheet.getByLabel("Anything else? (optional)").fill("Ticket spam.");
  await sheet.getByRole("button", { name: "Send report" }).click();
  await expect(sheet.getByRole("status")).toHaveText(
    "Thanks. A moderator will take a look.",
  );
  await readerContext.close();
  return { author, authorPage: page, authorContext };
}

test("remove a reported post with a note, and the author sees the note under Actions on your account", async ({
  page,
  request,
  browser,
}) => {
  const words = `Cheap tickets ${Math.random().toString(36).slice(2, 8)}`;
  const { author, authorPage, authorContext } = await reportedComment(
    browser,
    words,
  );
  await unlockedAdmin(page, request);

  await page.goto("/staff/moderation");
  await expect(heading(page)).toHaveText("Moderation queue");
  // Other specs share this database, so the item is picked by its words.
  const row = page.locator('[data-slot="mod-item"]').filter({ hasText: words });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("Open");
  await expect(row).toContainText("SPAM · POST");
  await expect(row).toContainText("Pit stop strategy · 1 report");
  await row.getByRole("link").click();

  const panel = page.locator('[data-slot="mod-panel"]');
  await expect(panel).toContainText(
    "WHAT WAS POSTED · SNAPSHOT AT FIRST REPORT",
  );
  await expect(panel.locator('[data-slot="mod-snapshot"]')).toContainText(
    words,
  );
  await expect(panel).toContainText("Spam · 1");
  await expect(panel).toContainText("“Ticket spam.”");
  await expect(panel).toContainText(author.username);
  await expectNoSeriousAxeViolations(page);

  const remove = panel.getByRole("button", { name: "Remove post" });
  await hydrated(remove);
  await expect(
    panel.getByRole("button", { name: "Mute the author for 7 days" }),
  ).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Keep it, close reports" }),
  ).toBeVisible();
  // A note is required.
  await remove.click();
  await expect(panel).toContainText("Give a reason");
  await panel
    .getByLabel("Note to the author (they see this, and can appeal)")
    .fill("Advertising isn't allowed in the forum.");
  await remove.click();
  await expect(panel.getByRole("status")).toHaveText(
    "Remove post: done. It's in Done now.",
  );
  await expect(panel).toContainText("Actioned · remove");

  // It's in Done, and no longer Open.
  await page.goto("/staff/moderation?tab=done");
  await expect(
    page.locator('[data-slot="mod-item"]').filter({ hasText: words }),
  ).toContainText("Actioned");

  // The author sees the action and the note.
  await authorPage.goto("/profile");
  const actions = authorPage.getByRole("region", {
    name: "ACTIONS ON YOUR ACCOUNT",
  });
  await expect(actions).toContainText(
    "Advertising isn't allowed in the forum.",
  );
  await authorContext.close();
});
