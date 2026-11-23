import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type Page,
} from "@playwright/test";
import {
  createAccount,
  expectNoSeriousAxeViolations,
  heading,
  hydrated,
  pageHydrated,
  signIn,
} from "../helpers/accounts";
import { setTrust } from "../helpers/forum";
import {
  addCrowd,
  FANTASY_ORIGIN,
  moveClock,
  ROUND_1,
  ROUND_2,
  runDueNow,
  seedGame,
  staleOverride,
  teamChangeReview,
} from "../helpers/game";
import { setUpTotp, unlockedAdmin } from "../helpers/staff";
import { buildTeam, createTeam, saveTeam } from "../helpers/team";

// M8's exit (Task 15) on the seeded 2026 game in replay mode: an admin
// unlocks with a code, moves a lock and finds it in the audit log, changes a
// setting, corrects a result, resolves a review item while a second admin's
// resolve of it is refused, and runs and approves a dry run; a moderator
// acts on a report and is refused the calendar; and axe finds nothing on
// every staff screen. At the plan's two sizes.

/** The staff screens, each checked with axe as the admin. */
const STAFF_SCREENS = [
  ["/staff", "Review queue"],
  ["/staff/calendar", "2026 calendar"],
  ["/staff/seats", "Drivers and seats"],
  ["/staff/scoring", "Scoring"],
  ["/staff/prices", "Prices"],
  ["/staff/review", "Review queue"],
  ["/staff/moderation", "Moderation queue"],
  ["/staff/users", "Users"],
  ["/staff/settings", "Settings"],
  ["/staff/audit", "Audit log"],
] as const;

const HOUR_MS = 3_600_000;
const REASON_LABEL = "Reason (saved in the audit log)";
/** A `datetime-local` value, in UTC. */
const utcInput = (ms: number) => new Date(ms).toISOString().slice(0, 16);
const tag = () => Math.random().toString(36).slice(2, 8);

test.beforeEach(async ({ page, request }) => {
  await seedGame(request, ROUND_1.beforeLock);
  // A player's team and a small crowd, so the dry run has teams to change.
  await createAccount(page.context().request, { origin: FANTASY_ORIGIN });
  await createTeam(page);
  await buildTeam(page);
  await saveTeam(page);
  await addCrowd(request, 2);
  await page.context().clearCookies();
});

/** The audit log has a row of `kind` with `reason`. */
async function inAuditLog(page: Page, kind: string, reason: string) {
  await page.goto("/staff/audit");
  await expect(
    page.getByRole("row").filter({ hasText: kind }).filter({ hasText: reason }),
  ).toHaveCount(1);
}

/** An author's forum post, reported as spam by a newcomer. Returns its words. */
async function reportedPost(browser: Browser): Promise<string> {
  const words = `Cheap tickets ${tag()}`;
  const authorContext = await browser.newContext();
  const author = await authorContext.newPage();
  const writer = await createAccount(authorContext.request, {
    origin: FANTASY_ORIGIN,
  });
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
  const newcomer = await createAccount(readerContext.request, {
    origin: FANTASY_ORIGIN,
  });
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
  return words;
}

/** The admin makes `username` a moderator from the users screen. */
async function makeModerator(page: Page, username: string) {
  await page.goto("/staff/users");
  const search = page.getByRole("search", { name: "Find a user" });
  const find = search.getByRole("button", { name: "Find" });
  await hydrated(find);
  await search.getByLabel("Username starts with").fill(username);
  await find.click();
  await page
    .locator('[data-slot="user-row"]')
    .filter({ hasText: username })
    .getByRole("link", { name: username })
    .click();
  const panel = page.locator('[data-slot="user-panel"]');
  const account = panel.getByRole("group", { name: "ACCOUNT" });
  const change = account.getByRole("button", { name: "Change role" });
  // It's enabled only once another role is picked (the panel opened in-app,
  // so the page is hydrated already).
  await expect(change).toBeDisabled();
  await account.getByLabel("Role").selectOption({ label: "Moderator" });
  await hydrated(change);
  await panel.getByLabel(REASON_LABEL).fill("Joins the moderation team");
  await change.click();
  await expect(panel.getByRole("status")).toHaveText("Change role: done.");
}

/** A moderator, signed in with two-step sign-in and staff tools unlocked. */
async function unlockedModerator(
  browser: Browser,
  admin: Page,
  request: APIRequestContext,
) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const account = await createAccount(request, { origin: FANTASY_ORIGIN });
  await makeModerator(admin, account.username);
  await signIn(page, account);
  const totp = await setUpTotp(page, account.password);
  const section = page.getByRole("region", { name: "Two-step sign-in" });
  await hydrated(section.getByRole("button", { name: "Unlock staff tools" }));
  await section
    .getByLabel("Code from your app, or a backup code")
    .fill(totp.backupCodes[0]!);
  await section.getByRole("button", { name: "Unlock staff tools" }).click();
  await expect(
    section.getByText("Staff tools are unlocked for this session."),
  ).toBeVisible();
  return { context, page };
}

for (const size of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
]) {
  test(`every board, by an admin and a moderator (${size.name})`, async ({
    page,
    request,
    browser,
  }) => {
    test.setTimeout(600_000);
    await page.setViewportSize(size);
    const run = tag();

    // An admin unlocks with a code.
    await unlockedAdmin(page, request, FANTASY_ORIGIN);

    // They move round 2's lock an hour early, and find it in the audit log.
    await page.goto("/staff/calendar");
    await page.getByRole("link", { name: /^Chinese Grand Prix/ }).click();
    const event = page.getByRole("region", { name: "Chinese Grand Prix" });
    const lock = event.getByRole("form", {
      name: "Lock for Chinese Grand Prix",
    });
    await hydrated(lock.getByRole("button", { name: "Save changes" }));
    await lock
      .getByRole("switch", { name: "Set the lock time by hand" })
      .click();
    await lock
      .getByLabel("Lock time (UTC)")
      .fill(utcInput(Date.parse(ROUND_2.lock) - HOUR_MS));
    const lockReason = `FIA moved sprint qualifying ${run}`;
    await lock.getByLabel(REASON_LABEL).fill(lockReason);
    await lock.getByRole("button", { name: "Save changes" }).click();
    await expect(event.getByRole("list", { name: "History" })).toContainText(
      lockReason,
    );
    await inAuditLog(page, "Lock time change", lockReason);

    // They change a setting, then put it back.
    for (const [why, checked] of [
      [`Push paused ${run}`, false],
      [`Push back on ${run}`, true],
    ] as const) {
      await page.goto("/staff/settings");
      const push = page.getByRole("switch", { name: "Push notifications" });
      await hydrated(push);
      await push.click();
      await page.getByLabel(REASON_LABEL).fill(why);
      await page.getByRole("button", { name: "Save settings" }).click();
      await expect(page.getByRole("status")).toHaveText(
        "Saved. It's in the audit log.",
      );
      if (checked) await expect(push).toBeChecked();
      else await expect(push).not.toBeChecked();
    }
    await inAuditLog(page, "Setting changed", `Push paused ${run}`);

    // They correct a result, once round 1's qualifying is in.
    await moveClock(request, ROUND_1.afterQualifying);
    await page.goto("/staff/calendar");
    await page.getByRole("link", { name: /^Australian Grand Prix/ }).click();
    await page
      .getByRole("region", { name: "Australian Grand Prix" })
      .getByRole("link", { name: "Results of Qualifying" })
      .click();
    const correct = page.getByRole("form", { name: "ADD A CORRECTION" });
    await hydrated(correct.getByRole("button", { name: "Save correction" }));
    const driver = correct.getByLabel("Driver");
    const norris = await driver
      .locator("option", { hasText: /^Norris/ })
      .textContent();
    await driver.selectOption({ label: norris! });
    await correct
      .getByLabel("What to change")
      .selectOption("Finishing position");
    await correct.getByLabel("New value").fill("12");
    await correct
      .getByLabel("Reason (players see this)")
      .fill(`Lap time deleted ${run}`);
    await correct.getByRole("button", { name: "Save correction" }).click();
    await expect(
      correct.getByText("Correction saved. The session is being re-scored."),
    ).toBeVisible();

    // After the race: a review item two admins open, and only one resolves.
    await moveClock(request, ROUND_1.afterRace);
    await teamChangeReview(request, "ALB", "haas");
    const openItem = async (on: Page) => {
      await on.goto("/staff/review");
      await on
        .getByRole("list", { name: "Open items" })
        .locator('[data-slot="review-item"]')
        .filter({ hasText: /Albon is at Haas/ })
        .getByRole("link")
        .click();
      const panel = on.locator('[data-slot="review-panel"]');
      const update = panel.getByRole("button", {
        name: "Update seats from this event on",
      });
      await hydrated(update);
      return { panel, update };
    };
    const mine = await openItem(page);
    const otherContext = await browser.newContext();
    const other = await otherContext.newPage();
    await other.setViewportSize(size);
    await unlockedAdmin(other, request, FANTASY_ORIGIN);
    const theirs = await openItem(other);
    await theirs.panel
      .getByLabel(REASON_LABEL)
      .fill(`Albon moves to Haas ${run}`);
    await theirs.update.click();
    await expect(
      theirs.panel.getByText(
        "Update seats from this event on: done. It's in Resolved now.",
      ),
    ).toBeVisible();
    await otherContext.close();
    await mine.panel.getByLabel(REASON_LABEL).fill(`Same change ${run}`);
    await mine.update.click();
    await expect(
      mine.panel.getByText("Someone else dealt with this first."),
    ).toBeVisible();

    // They run a dry run of Albon's disqualification, and approve it.
    await staleOverride(request, "ALB");
    await page.goto("/staff/scoring");
    const start = page.getByRole("form", { name: "START A DRY RUN" });
    await hydrated(start.getByRole("button", { name: "Start a dry run" }));
    await start.getByLabel(REASON_LABEL).fill(`Check Albon ${run}`);
    await start.getByRole("button", { name: "Start a dry run" }).click();
    await expect(heading(page)).toHaveText("Scoring dry run");
    // It scores as jobs (M9 Task 7): running until the tick runs them.
    await expect(
      page.getByText("This dry run is still scoring. Reload in a minute."),
    ).toBeVisible();
    await runDueNow(request);
    await page.reload();
    await expect(
      page.getByRole("list", { name: "Dry run totals" }),
    ).toBeVisible();
    const decide = page.getByRole("form", {
      name: "Approve or discard the dry run",
    });
    await decide.getByLabel(REASON_LABEL).fill(`Matches the stewards ${run}`);
    await decide.getByRole("button", { name: "Approve and re-score" }).click();
    await expect(
      page.getByText(
        /The last dry run was approved, and its re-score is queued/,
      ),
    ).toBeVisible();
    await inAuditLog(page, "Re-score approved", `Matches the stewards ${run}`);

    // Axe finds nothing on every staff screen.
    for (const [href, title] of STAFF_SCREENS) {
      await page.goto(href);
      await expect(heading(page)).toHaveText(title);
      await expectNoSeriousAxeViolations(page);
    }

    // A moderator acts on a report, and is refused the calendar.
    const words = await reportedPost(browser);
    const moderator = await unlockedModerator(browser, page, request);
    const mod = moderator.page;
    await mod.setViewportSize(size);
    await mod.goto("/staff/moderation");
    await expect(heading(mod)).toHaveText("Moderation queue");
    await mod
      .locator('[data-slot="mod-item"]')
      .filter({ hasText: words })
      .getByRole("link")
      .click();
    const item = mod.locator('[data-slot="mod-panel"]');
    const remove = item.getByRole("button", { name: "Remove post" });
    await hydrated(remove);
    await item
      .getByLabel("Note to the author (they see this, and can appeal)")
      .fill("Advertising isn't allowed in the forum.");
    await remove.click();
    await expect(item.getByRole("status")).toHaveText(
      "Remove post: done. It's in Done now.",
    );
    await expectNoSeriousAxeViolations(mod);
    await expect(
      mod.getByRole("navigation").getByRole("link", { name: "Calendar" }),
    ).toHaveCount(0);
    await mod.goto("/staff/calendar");
    await expect(mod.getByText("Your role can't do this.")).toBeVisible();
    await moderator.context.close();
  });
}
