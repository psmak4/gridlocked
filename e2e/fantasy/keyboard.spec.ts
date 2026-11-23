import { expect, test, type Page } from "@playwright/test";
import {
  createAccount,
  heading,
  newEmail,
  newUsername,
  pageHydrated,
  PASSWORD,
} from "../helpers/accounts";
import { tabTo, wcagViolations } from "../helpers/a11y";
import { reportedPost, setTrust } from "../helpers/forum";
import { FANTASY_ORIGIN, ROUND_1, moveClock, seedGame } from "../helpers/game";
import { picker, saveButton } from "../helpers/team";

// The keyboard pass (M9 Task 8): the beta's main flows with the keyboard
// only. Every control is reached with Tab and shows a focus ring
// (`tabTo`); nothing is clicked.

test.beforeEach(async ({ request }) => {
  await seedGame(request, ROUND_1.beforeLock);
});

/** Picks `name` in the open picker with the keyboard. */
async function keyboardChoose(page: Page, name: RegExp) {
  const sheet = picker(page);
  await expect(sheet.getByRole("list")).toBeVisible();
  const all = sheet.getByRole("button", { name: /^See all/ });
  if (await all.isVisible()) {
    await tabTo(page, all);
    await page.keyboard.press("Enter");
  }
  await tabTo(page, sheet.getByRole("button", { name }), { max: 120 });
  await page.keyboard.press("Enter");
  await expect(sheet).toBeHidden();
}

test("sign up with the keyboard only", async ({ page }) => {
  await page.goto("/sign-up/email");
  await pageHydrated(page);
  await tabTo(page, page.getByLabel("Email"));
  await page.keyboard.type(newEmail());
  await tabTo(page, page.getByLabel("Password"));
  await page.keyboard.type(PASSWORD);
  await tabTo(page, page.getByLabel("Username"));
  await page.keyboard.type(newUsername());
  await tabTo(page, page.getByRole("checkbox", { name: "I'm 16 or older" }));
  await page.keyboard.press("Space");
  await tabTo(
    page,
    page.getByRole("checkbox", { name: /I agree to the Terms/ }),
  );
  await page.keyboard.press("Space");
  await tabTo(page, page.getByRole("button", { name: "Create account" }));
  await page.keyboard.press("Enter");
  await expect(heading(page)).toHaveText("Check your email");
});

test("build a team, then see it locked, with the keyboard only", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  await createAccount(page.context().request, { origin: FANTASY_ORIGIN });
  await page.goto("/team");
  await pageHydrated(page);
  await tabTo(page, page.getByLabel("Team name"));
  await page.keyboard.type("Box Box");
  await tabTo(page, page.getByRole("button", { name: "Create a team" }));
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL("/team/1");
  await pageHydrated(page);

  const picks: ["driver" | "constructor", RegExp][] = [
    ["driver", /Albon/],
    ["driver", /Sainz/],
    ["driver", /Alonso/],
    ["driver", /Hülkenberg/],
    ["driver", /Bearman/],
    ["constructor", /Williams/],
    ["constructor", /RB F1 Team/],
  ];
  for (const [kind, name] of picks) {
    await tabTo(
      page,
      page.getByRole("button", { name: `Add a ${kind}` }).first(),
      {
        max: 120,
      },
    );
    await page.keyboard.press("Enter");
    await keyboardChoose(page, name);
  }
  // The 2× Boost on Albon, from his row's button.
  const albon = page
    .getByRole("region", { name: "DRIVERS" })
    .locator("li[data-asset-id]")
    .filter({ hasText: /Albon/ })
    .getByRole("button");
  await tabTo(page, albon, { max: 120 });
  await page.keyboard.press("Enter");
  const sheet = picker(page);
  await tabTo(page, sheet.getByRole("switch", { name: "2× Boost" }));
  await page.keyboard.press("Space");
  await tabTo(page, sheet.getByRole("button", { name: "Cancel" }));
  await page.keyboard.press("Enter");
  await expect(sheet).toBeHidden();
  await tabTo(page, saveButton(page), { max: 120 });
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("status").filter({ hasText: "Team saved" }),
  ).toBeVisible();

  // The lock: the locked team reads in full from the keyboard.
  await moveClock(request, ROUND_1.afterLock);
  await page.goto("/team/1");
  await pageHydrated(page);
  await expect(page.getByText("Locked until after the race")).toBeVisible();
  expect(await wcagViolations(page)).toEqual([]);
  await tabTo(page, page.getByRole("link", { name: /Box Box|Team/ }).first(), {
    max: 60,
  });
});

test("a reveal with the keyboard only", async ({ page, request }) => {
  await moveClock(request, ROUND_1.final);
  await page.goto("/prices");
  await pageHydrated(page);
  await expect(page.getByText("Round 1 — price changes are in")).toBeVisible();
  await tabTo(page, page.getByRole("tab", { name: "Going up" }));
  await page.keyboard.press("Enter");
  await tabTo(page, page.getByRole("button", { name: "Show it" }));
  await page.keyboard.press("Enter");
  await expect(page.getByRole("list", { name: "Going up" })).toContainText("▲");
});

test("chat with the keyboard only", async ({ page, request }) => {
  await moveClock(request, ROUND_1.afterLock);
  const account = await createAccount(page.context().request, {
    origin: FANTASY_ORIGIN,
  });
  await setTrust(page.context().request, account.email, 1);
  await page.goto("/forum/race-weekend");
  await pageHydrated(page);
  await tabTo(
    page,
    page
      .getByRole("list", { name: "Threads" })
      .getByRole("link", { name: /· Qualifying/ }),
  );
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/t\/[0-9a-f-]{36}$/);
  await pageHydrated(page);
  await tabTo(page, page.getByRole("button", { name: "Mark as watched" }));
  await page.keyboard.press("Enter");
  const message = page.getByRole("textbox", { name: "Message" });
  await tabTo(page, message);
  await page.keyboard.type("Lights out soon");
  await tabTo(page, page.getByRole("button", { name: "Send" }));
  await page.keyboard.press("Enter");
  await expect(page.getByRole("log", { name: "Chat messages" })).toContainText(
    "Lights out soon",
  );
  expect(await wcagViolations(page)).toEqual([]);
});

test("a report with the keyboard only", async ({ page, browser }) => {
  const { threadUrl } = await reportedPost(browser, FANTASY_ORIGIN);
  const reader = await createAccount(page.context().request, {
    origin: FANTASY_ORIGIN,
  });
  await setTrust(page.context().request, reader.email, 1);
  await page.goto(threadUrl);
  await pageHydrated(page);
  const more = page
    .getByRole("list", { name: "Comments" })
    .getByRole("button", { name: /^More for the post by / })
    .first();
  await tabTo(page, more, { max: 120 });
  await page.keyboard.press("Enter");
  const report = page.getByRole("menuitem", { name: "Report" });
  for (let i = 0; i < 6; i++) {
    if (await report.evaluate((el) => el === document.activeElement)) break;
    await page.keyboard.press("ArrowDown");
  }
  await expect(report).toBeFocused();
  await page.keyboard.press("Enter");
  const sheet = page.getByRole("dialog", { name: "Report" });
  // The sheet moves focus into itself once it has opened; a Tab pressed
  // before then can be overtaken by it.
  await expect
    .poll(() => sheet.evaluate((el) => el.contains(document.activeElement)))
    .toBe(true);
  // A radio group is one tab stop: Tab reaches its first choice, and the
  // arrow keys move (and check) within it.
  await tabTo(page, sheet.getByRole("radio", { name: "Spam" }));
  await page.keyboard.press("ArrowDown");
  const abuse = sheet.getByRole("radio", { name: "Abuse or harassment" });
  await expect(abuse).toBeFocused();
  await expect(abuse).toBeChecked();
  await tabTo(page, sheet.getByRole("button", { name: "Send report" }));
  await page.keyboard.press("Enter");
  await expect(sheet.getByRole("status")).toHaveText(
    "Thanks. A moderator will take a look.",
  );
});
