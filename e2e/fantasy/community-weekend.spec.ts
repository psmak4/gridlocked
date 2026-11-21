import { readFile } from "node:fs/promises";
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";
import {
  createAccount,
  expectNoSeriousAxeViolations,
  pageHydrated,
} from "../helpers/accounts";
import { setTrust } from "../helpers/forum";
import { FANTASY_ORIGIN, ROUND_1, moveClock, seedGame } from "../helpers/game";

// M7's exit (Task 16): one race weekend on the seeded 2026 game, at phone
// size on the replay-mode build. Melbourne's threads open on the Monday of
// its week; qualifying is on Saturday 7 March at 05:00 UTC and the race on
// Sunday 8 March at 04:00 UTC. Then the clock runs on past the race chat's
// 30 days, to its archive, its replay and the export.

const BEFORE_WEEK = "2026-03-01T12:00:00.000Z";
const WEEK_OPEN = "2026-03-02T06:00:00.000Z";
const RACE_LIVE = "2026-03-08T04:01:00.000Z";
/** Past the race chat's close plus 30 days, and the next daily job. */
const ARCHIVED = "2026-04-09T12:00:00.000Z";

const TITLE = "Russell on pole";
const REPLY = "He was quickest in every practice.";
const CHAT = "Lights out and away we go";

type Person = {
  context: BrowserContext;
  page: Page;
  username: string;
  email: string;
};

async function person(browser: Browser, trust: 0 | 1 | 3): Promise<Person> {
  const context = await browser.newContext({ baseURL: FANTASY_ORIGIN });
  const account = await createAccount(context.request, {
    origin: FANTASY_ORIGIN,
  });
  await setTrust(context.request, account.email, trust);
  return { context, page: await context.newPage(), ...account };
}

/** Opens a session thread from the Race Weekend list by its label. */
async function openSession(page: Page, label: "Qualifying" | "Race") {
  await page.goto("/forum/race-weekend");
  await page
    .getByRole("list", { name: "Threads" })
    .getByRole("link", { name: new RegExp(`· ${label}\\b`) })
    .first()
    .click();
  await expect(page).toHaveURL(/\/t\/[0-9a-f-]{36}$/);
  await pageHydrated(page);
}

const notificationList = (page: Page) =>
  page.getByRole("list", { name: "Notifications" });

test("a race weekend in the community, start to archive", async ({
  request,
  browser,
}) => {
  test.setTimeout(900_000);

  await test.step("the event week opens one thread per session", async () => {
    await seedGame(request, BEFORE_WEEK);
    const visitor = await browser.newPage({ baseURL: FANTASY_ORIGIN });
    await visitor.goto("/forum/race-weekend");
    await expect(
      visitor.getByRole("link", { name: /· Qualifying\b/ }),
    ).toHaveCount(0);
    await moveClock(request, WEEK_OPEN);
    await visitor.reload();
    const threads = visitor.getByRole("list", { name: "Threads" });
    for (const label of ["Practice 1", "Qualifying", "Race"]) {
      await expect(
        threads.getByRole("link", { name: new RegExp(`· ${label}\\b`) }),
      ).not.toHaveCount(0);
    }
    await visitor.close();
  });

  await moveClock(request, ROUND_1.afterLock);
  const alice = await person(browser, 1);
  const bob = await person(browser, 0);
  const carol = await person(browser, 3);
  let threadPath = "";

  await test.step("a spoiler thread, and a reply with spoiler-safe text", async () => {
    const { page } = alice;
    await page.goto("/forum/new?category=race-weekend");
    await pageHydrated(page);
    await page.getByLabel("Title").fill(TITLE);
    await expect(
      page.getByRole("checkbox", { name: "Contains spoilers for qualifying" }),
    ).toBeChecked();
    await page.getByLabel("Post").fill("Called it on Friday.");
    await page.getByRole("button", { name: "Post thread" }).click();
    await expect(page).toHaveURL(/\/t\/[0-9a-f-]{36}$/);
    threadPath = new URL(page.url()).pathname;

    await bob.page.goto(threadPath);
    await pageHydrated(bob.page);
    await expect(bob.page.getByText("Spoiler protected")).toBeVisible();
    await bob.page.getByRole("button", { name: "Show it" }).click();
    await bob.page.getByLabel("Add a comment").fill(REPLY);
    await bob.page.getByRole("button", { name: "Post comment" }).click();
    await expect(
      bob.page.getByRole("list", { name: "Comments" }),
    ).toContainText(REPLY);

    await page.goto("/notifications");
    const list = notificationList(page);
    await expect(list).toContainText(`${bob.username} replied in “`);
    await expect(list).not.toContainText(TITLE);
  });

  await test.step("qualifying is hidden until Mark as watched", async () => {
    const { page } = alice;
    await openSession(page, "Qualifying");
    await expect(page.getByText("Spoiler protected")).toBeVisible();
    await page.getByRole("button", { name: "Mark as watched" }).click();
    await expect(
      page.getByRole("heading", { name: /^Live chat/ }),
    ).toBeVisible();
    // Watched, the reply's notification says what it is about.
    await page.goto("/notifications");
    await expect(notificationList(page)).toContainText(
      `${bob.username} replied in “${TITLE}”`,
    );
  });

  let replyId = "";
  await test.step("a report hides the reply", async () => {
    replyId =
      (await bob.page
        .locator("[data-post]")
        .filter({ hasText: REPLY })
        .last()
        .getAttribute("data-post")) ?? "";
    expect(replyId).toMatch(/^[0-9a-f-]{36}$/);

    const { page } = carol;
    await page.goto(threadPath);
    await pageHydrated(page);
    await page.getByRole("button", { name: "Show it" }).click();
    const more = page
      .getByRole("list", { name: "Comments" })
      .getByRole("button", { name: `More for the post by ${bob.username}` });
    await more.click();
    await page.getByRole("menuitem", { name: "Report" }).click();
    const sheet = page.getByRole("dialog", { name: "Report" });
    await sheet.getByRole("radio", { name: "Spam" }).check();
    await sheet.getByRole("button", { name: "Send report" }).click();
    await expect(sheet.getByRole("status")).toHaveText(
      "Thanks. A moderator will take a look.",
    );

    await alice.page.goto(threadPath);
    await expect(alice.page.getByText(REPLY)).toHaveCount(0);
  });

  await test.step("a moderator restores it with the staff command", async () => {
    const ran = await request.post("/api/test/staff", {
      data: {
        command: "moderate",
        env: {
          STAFF_CHANGE: JSON.stringify({
            action: "restore",
            target: "post",
            id: replyId,
          }),
          STAFF_REASON: "Not spam: a fair point about practice",
          STAFF_ACTOR: "exit-spec",
          STAFF_DRY_RUN: "false",
        },
      },
    });
    expect(ran.status(), await ran.text()).toBe(200);
    await alice.page.goto(threadPath);
    await expect(alice.page.getByText(REPLY)).toBeVisible();
  });

  await test.step("a logged-out visitor sees the safe view, then the toggle", async () => {
    const context = await browser.newContext({ baseURL: FANTASY_ORIGIN });
    const visit = await context.newPage();
    await visit.goto(threadPath);
    await pageHydrated(visit);
    await expect(visit.getByRole("heading", { level: 1 })).toHaveText(
      /^Spoiler thread · .+ qualifying$/,
    );
    await expect(visit.getByText(REPLY)).toHaveCount(0);
    await visit
      .getByRole("switch", { name: "Show results everywhere on this device" })
      .click();
    await expect(visit.getByRole("heading", { level: 1 })).toHaveText(TITLE);
    await expect(visit.getByText(REPLY)).toBeVisible();
    await context.close();
  });

  await test.step("qualifying's results post is a link", async () => {
    await moveClock(request, ROUND_1.afterQualifying);
    const { page } = alice;
    await openSession(page, "Qualifying");
    await expect(
      page.getByRole("link", { name: "Results and points" }),
    ).toHaveAttribute("href", "/weekend");
  });

  let racePath = "";
  await test.step("race chat, with slow mode", async () => {
    await moveClock(request, RACE_LIVE);
    const { page } = bob;
    await openSession(page, "Race");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "Australian GP · Race",
    );
    racePath = new URL(page.url()).pathname;
    await page.getByRole("button", { name: "Mark as watched" }).click();
    await expect(
      page.getByRole("heading", { name: /^Live chat · Slow mode/ }),
    ).toBeVisible();
    const message = page.getByRole("textbox", { name: "Message" });
    await message.fill(CHAT);
    await page.getByRole("button", { name: "Send" }).click();
    await expect(
      page.getByRole("log", { name: "Chat messages" }),
    ).toContainText(CHAT);
    await message.fill("Purple first sector");
    await expect(
      page.getByRole("button", { name: /^Wait \d+s$/ }),
    ).toBeDisabled();
    await expectNoSeriousAxeViolations(page);
  });

  await test.step("30 days on, the chat is archived and replays", async () => {
    // A week at a time: every job on the way runs, rounds 2 and 3 included.
    for (const to of [
      "2026-03-15T12:00:00.000Z",
      "2026-03-22T12:00:00.000Z",
      "2026-03-29T12:00:00.000Z",
      "2026-04-05T12:00:00.000Z",
      ARCHIVED,
    ]) {
      await moveClock(request, to);
    }
    const { page } = bob;
    // Later rounds' threads are above it in the list by now.
    await page.goto(racePath);
    const replay = page.getByText(/^Chat replay · \d+ messages?$/);
    await expect(replay).toBeVisible();
    // Folded under the discussion; opening it reads the archive.
    await replay.click();
    await expect(page.getByRole("list", { name: "Chat replay" })).toContainText(
      CHAT,
    );
  });

  await test.step("the export includes the archived chat", async () => {
    const { page, context } = bob;
    await page.goto("/settings/data");
    await page.getByRole("button", { name: "Request my data" }).click();
    await expect(page.getByText("Ready within a few hours")).toBeVisible();
    const ran = await context.request.post("/api/test/run-exports", {
      headers: { origin: FANTASY_ORIGIN },
    });
    expect(ran.status(), await ran.text()).toBe(200);
    await page.reload();
    const [file] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("link", { name: "Download the file" }).click(),
    ]);
    const body = JSON.parse(await readFile((await file.path())!, "utf8")) as {
      chat: Array<{ body?: string; status?: string }>;
    };
    // From the archive file: the rows themselves went when it was written.
    expect(body.chat).toContainEqual(
      expect.objectContaining({ body: CHAT, status: "archived" }),
    );
  });

  for (const p of [alice, bob, carol]) await p.context.close();
});
