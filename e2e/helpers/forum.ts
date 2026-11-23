import { expect, type APIRequestContext, type Browser } from "@playwright/test";
import { createAccount, hydrated, pageHydrated } from "./accounts";

const tag = () => Math.random().toString(36).slice(2, 8);

/**
 * Marks an account's address verified and sets its trust level, through the
 * local-only `/api/test/community` hook: a new account is TL0 and unverified,
 * and the forum needs it verified to post.
 */
export async function setTrust(
  request: APIRequestContext,
  email: string,
  trustLevel: 0 | 1 | 2 | 3,
): Promise<void> {
  const response = await request.post("/api/test/community", {
    data: { email, trustLevel },
  });
  expect(response.status(), await response.text()).toBe(200);
  expect(((await response.json()) as { changed: number }).changed).toBe(1);
}

/**
 * An author's forum post, reported as spam by a newcomer, on the server at
 * `origin`. Returns its words and its thread's address.
 */
export async function reportedPost(
  browser: Browser,
  origin: string,
): Promise<{ words: string; threadUrl: string }> {
  const words = `Cheap tickets ${tag()}`;
  const authorContext = await browser.newContext();
  const author = await authorContext.newPage();
  const writer = await createAccount(authorContext.request, { origin });
  await setTrust(authorContext.request, writer.email, 1);
  await author.goto("/forum/new?category=general");
  await pageHydrated(author);
  await author.getByLabel("Title").fill(`Pit stop strategy ${tag()}`);
  await author.getByLabel("Post").fill("Two stops, surely.");
  await author.getByRole("button", { name: "Post thread" }).click();
  await expect(author).toHaveURL(/\/t\/[0-9a-f-]{36}$/);
  const threadUrl = author.url();
  await author.getByLabel("Add a comment").fill(words);
  await author.getByRole("button", { name: "Post comment" }).click();
  await expect(author.getByRole("list", { name: "Comments" })).toContainText(
    words,
  );
  await authorContext.close();

  const readerContext = await browser.newContext();
  const reader = await readerContext.newPage();
  const newcomer = await createAccount(readerContext.request, { origin });
  await setTrust(readerContext.request, newcomer.email, 0);
  await reader.goto(threadUrl);
  await pageHydrated(reader);
  const more = reader
    .getByRole("list", { name: "Comments" })
    .getByRole("button", { name: `More for the post by ${writer.username}` });
  await hydrated(more);
  await more.click();
  await reader.getByRole("menuitem", { name: "Report" }).click();
  const sheet = reader.getByRole("dialog", { name: "Report" });
  await sheet.getByRole("radio", { name: "Spam" }).check();
  await sheet.getByRole("button", { name: "Send report" }).click();
  await expect(sheet.getByRole("status")).toHaveText(
    "Thanks. A moderator will take a look.",
  );
  await readerContext.close();
  return { words, threadUrl };
}
