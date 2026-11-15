import {
  expect,
  test,
  type Browser,
  type Locator,
  type Page,
} from "@playwright/test";
import {
  createAccount,
  expectNoSeriousAxeViolations,
  heading,
  hydrated,
} from "../helpers/accounts";
import {
  FANTASY_ORIGIN,
  ROUND_1,
  moveClock,
  seedGame,
  withdrawDriver,
} from "../helpers/game";

// The team builder and the driver picker (M6 Task 8), on the seeded 2026
// game at phone size. Prices are our own (tests/fixtures/prices-2026.json),
// in $M: Norris 28.0, Verstappen 27.0, Piastri 25.0, Russell 22.0, Albon
// 13.5, Sainz 12.0, Alonso 11.0, Hülkenberg 9.5, Bearman 8.0, Stroll 6.0,
// Gasly 5.2, Bottas 3.6, Lindblad 3.2; Williams 17.0, RB F1 Team 13.0,
// Haas 9.0, Alpine 6.0, Cadillac 4.0. The cap is $100M.

test.beforeEach(async ({ page, request }) => {
  await seedGame(request, ROUND_1.beforeLock);
  await createAccount(page.context().request, { origin: FANTASY_ORIGIN });
});

const saveButton = (page: Page) =>
  page.getByRole("button", { name: "Save team" });
const picker = (page: Page) => page.getByRole("dialog");
/** The constructors this spec uses; every other name is a driver. */
const CONSTRUCTOR = /Williams|F1 Team/;

/**
 * A picked row, in its own section: a driver row's subtitle names its
 * constructor, and a constructor row's names its drivers, so a name alone
 * would match both.
 */
const teamRow = (page: Page, name: RegExp) =>
  page
    .getByRole("region", {
      name: CONSTRUCTOR.test(name.source) ? "CONSTRUCTORS" : "DRIVERS",
    })
    .locator("li[data-asset-id]")
    .filter({ hasText: name });
const DRAFT_PREFIX = "gridlocked:draft:";

/** Creates "Box Box" and lands in its builder, hydrated. */
async function createTeam(page: Page) {
  await page.goto("/team");
  const create = page.getByRole("button", { name: "Create a team" });
  await hydrated(create);
  await page.getByLabel("Team name").fill("Box Box");
  await create.click();
  await expect(page).toHaveURL("/team/1");
  await hydrated(page.getByRole("button", { name: "Add a driver" }).first());
}

/** Picks `name` in the open picker, from all of the pool. */
async function choose(page: Page, name: RegExp) {
  const sheet = picker(page);
  await expect(sheet.getByRole("list")).toBeVisible();
  const all = sheet.getByRole("button", { name: /^See all/ });
  if (await all.isVisible()) await all.click();
  await sheet.getByRole("button", { name }).click();
  await expect(sheet).toBeHidden();
}

/** Fills an empty slot. */
async function add(page: Page, kind: "driver" | "constructor", name: RegExp) {
  await page
    .getByRole("button", { name: `Add a ${kind}` })
    .first()
    .click();
  await choose(page, name);
}

/** Opens a picked row's picker and swaps it for `into`. */
async function swap(page: Page, out: RegExp, into: RegExp) {
  await teamRow(page, out).getByRole("button").click();
  await choose(page, into);
}

/** Puts the 2× Boost on a picked driver. */
async function boost(page: Page, name: RegExp) {
  await teamRow(page, name).getByRole("button").click();
  const sheet = picker(page);
  await sheet.getByRole("switch", { name: "2× Boost" }).click();
  await sheet.getByRole("button", { name: "Cancel" }).click();
  await expect(sheet).toBeHidden();
}

/** Albon (Boost), Sainz, Alonso, Hülkenberg, Bearman; Williams, RB F1 Team: $84.0M. */
async function buildTeam(page: Page) {
  for (const name of [/Albon/, /Sainz/, /Alonso/, /Hülkenberg/, /Bearman/]) {
    await add(page, "driver", name);
  }
  await add(page, "constructor", /Williams/);
  await add(page, "constructor", /RB F1 Team/);
  await boost(page, /Albon/);
}

async function saveTeam(page: Page) {
  await saveButton(page).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Team saved" }),
  ).toBeVisible();
}

const draftKeys = (page: Page) =>
  page.evaluate(
    (prefix) =>
      Object.keys(window.localStorage).filter((k) => k.startsWith(prefix)),
    DRAFT_PREFIX,
  );

/** A second device: a new browser context signed in as the same account. */
async function secondDevice(browser: Browser, page: Page) {
  const context = await browser.newContext({
    baseURL: FANTASY_ORIGIN,
    viewport: { width: 390, height: 844 },
    storageState: {
      cookies: (await page.context().storageState()).cookies,
      origins: [],
    },
  });
  return context.newPage();
}

test("build a first team: pick 5 drivers and 2 constructors, choose the Boost, save, see Team saved, and reload to the same team", async ({
  page,
}) => {
  await createTeam(page);
  await expect(heading(page)).toHaveText("Box Box");
  await expect(
    page.getByText("Pick 5 drivers and 2 constructors to save."),
  ).toBeVisible();
  await expect(saveButton(page)).toBeDisabled();

  await buildTeam(page);
  await expect(
    page.getByRole("meter", { name: "Budget used" }),
  ).toHaveAttribute("aria-valuetext", "$84M of $100M");
  await expect(teamRow(page, /Albon/)).toContainText("2×");
  await saveTeam(page);
  expect(await draftKeys(page)).toEqual([]);

  await page.reload();
  await hydrated(teamRow(page, /Albon/).getByRole("button"));
  for (const name of [
    /Albon/,
    /Sainz/,
    /Alonso/,
    /Hülkenberg/,
    /Bearman/,
    /Williams/,
    /RB F1 Team/,
  ]) {
    await expect(teamRow(page, name)).toBeVisible();
  }
  await expect(teamRow(page, /Albon/)).toContainText("2×");
  // Nothing changed since the save.
  await expect(saveButton(page)).toBeDisabled();
});

test("a draft survives a reload until it is saved", async ({ page }) => {
  await createTeam(page);
  await add(page, "driver", /Albon/);
  await add(page, "driver", /Sainz/);
  await page.reload();
  await expect(teamRow(page, /Albon/)).toBeVisible();
  await expect(teamRow(page, /Sainz/)).toBeVisible();
  await expect(
    page.getByText("Pick 3 more drivers and 2 more constructors to save."),
  ).toBeVisible();
});

test("a driver you can't afford is shown, disabled, with how much over", async ({
  page,
}) => {
  await createTeam(page);
  for (const name of [/Norris/, /Verstappen/, /Piastri/]) {
    await add(page, "driver", name);
  }
  // $80.0M spent: $20.0M left for this slot.
  await page.getByRole("button", { name: "Add a driver" }).first().click();
  const sheet = picker(page);
  await expect(sheet.getByText("You can spend up to $20.0M.")).toBeVisible();
  const russell = sheet.getByRole("button", { name: /Russell/ });
  await expect(russell).toBeVisible();
  await expect(russell).toHaveAttribute("aria-disabled", "true");
  await expect(russell).toContainText("$2.0M over budget");
  // The window starts one row above what the team can afford.
  await expect(
    sheet.getByRole("button", { name: /^See all 2\d drivers$/ }),
  ).toBeVisible();
  // A tap on it does nothing (Playwright waits for an enabled row, so force).
  await russell.click({ force: true });
  await expect(sheet).toBeVisible();
  await expect(page.locator("main li[data-asset-id]")).toHaveCount(3);
});

test("over the cap: Save is disabled and the sentence says by how much", async ({
  page,
}) => {
  await createTeam(page);
  // $96.8M of picks, all affordable one at a time.
  for (const name of [
    /Norris/,
    /Verstappen/,
    /Piastri/,
    /Lindblad/,
    /Bottas/,
  ]) {
    await add(page, "driver", name);
  }
  await add(page, "constructor", /Cadillac/);
  await add(page, "constructor", /Alpine/);
  await boost(page, /Norris/);
  await expect(saveButton(page)).toBeEnabled();

  // A draft from before prices moved: Lindblad's slot holds Russell. The
  // picker never offers that, so the draft is written as it would be stored.
  const [key] = await draftKeys(page);
  const russellId = await (async () => {
    await swapOpen(page, /Lindblad/);
    const sheet = picker(page);
    await sheet.getByRole("button", { name: /^See all/ }).click();
    const id = await sheet
      .locator("li[data-asset-id]")
      .filter({ hasText: /Russell/ })
      .getAttribute("data-asset-id");
    await sheet.getByRole("button", { name: "Cancel" }).click();
    return id!;
  })();
  const lindbladId = await teamRow(page, /Lindblad/).getAttribute(
    "data-asset-id",
  );
  await page.evaluate(
    ({ key, out, into }) => {
      const picks = JSON.parse(window.localStorage.getItem(key)!) as Array<{
        assetId: string;
        isBoost: boolean;
      }>;
      window.localStorage.setItem(
        key,
        JSON.stringify(
          picks.map((p) => (p.assetId === out ? { ...p, assetId: into } : p)),
        ),
      );
    },
    { key: key!, out: lindbladId!, into: russellId },
  );
  await page.reload();
  await expect(teamRow(page, /Russell/)).toBeVisible();
  // $96.8M − $3.2M + $22.0M = $115.6M.
  await expect(
    page.getByText("You're $15.6M over the cap. Swap one driver to save."),
  ).toBeVisible();
  await expect(
    page.getByRole("meter", { name: "Budget used" }),
  ).toHaveAttribute("aria-valuetext", "Over by $15.6M");
  await hydrated(teamRow(page, /Russell/).getByRole("button"));
  await expect(saveButton(page)).toBeDisabled();
});

/** Opens a picked row's picker. */
async function swapOpen(page: Page, name: RegExp) {
  await teamRow(page, name).getByRole("button").click();
  await expect(picker(page)).toBeVisible();
}

test("after round 1 is final, three changes show one extra transfer and its penalty", async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  await createTeam(page);
  await buildTeam(page);
  await saveTeam(page);

  await moveClock(request, ROUND_1.final);
  await page.reload();
  await expect(page.getByText(/^Round 2 ·/)).toBeVisible();
  await hydrated(teamRow(page, /Sainz/).getByRole("button"));
  // Round 1's team is the base: nothing changed yet.
  await expect(page.getByText("0 of 2 free transfers used")).toBeVisible();

  await swap(page, /Sainz/, /Gasly/);
  await expect(page.getByText("1 of 2 free transfers used")).toBeVisible();
  await swap(page, /Alonso/, /Stroll/);
  await swap(page, /RB F1 Team/, /Haas/);
  await expect(page.getByText("3 changes · 1 costs 10 pts")).toBeVisible();
  await expect(
    page.getByText(
      "3 changes this week. 2 are free, so the third costs 10 points.",
    ),
  ).toBeVisible();
  await expect(teamRow(page, /Gasly/)).toContainText("New");
  // An extra transfer is allowed: it costs points at the lock.
  await saveTeam(page);
});

test("two pages on one team: the second save says your other device saved changes, and keeps its own draft", async ({
  page,
  browser,
}) => {
  await createTeam(page);
  await buildTeam(page);
  await saveTeam(page);

  const other = await secondDevice(browser, page);
  await other.goto("/team/1");
  await hydrated(teamRow(other, /Alonso/).getByRole("button"));

  // This device swaps Sainz for Gasly and saves first.
  await swap(page, /Sainz/, /Gasly/);
  await saveTeam(page);

  // The other device, still on the old team, swaps Alonso for Stroll.
  await swap(other, /Alonso/, /Stroll/);
  await saveButton(other).click();
  const toast = other.getByRole("status").filter({
    hasText: "Your other device saved changes",
  });
  await expect(toast).toBeVisible();
  // Its own team went through, as it was on its screen.
  await expect(teamRow(other, /Stroll/)).toBeVisible();
  await expect(teamRow(other, /Sainz/)).toBeVisible();

  await toast.getByRole("button", { name: "See their team" }).click();
  await expect(teamRow(other, /Gasly/)).toBeVisible();
  await expect(teamRow(other, /Alonso/)).toBeVisible();
  await expect(saveButton(other)).toBeEnabled();
  await other.context().close();
});

test("a page opened before the lock, saved after it, says the team locked and keeps the draft", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  await createTeam(page);
  await buildTeam(page);
  await saveTeam(page);
  await swap(page, /Sainz/, /Gasly/);
  expect(await draftKeys(page)).toHaveLength(1);

  await moveClock(request, ROUND_1.afterLock);
  await saveButton(page).click();
  // The viewer's time zone is UTC until they choose one.
  const at = new Date(ROUND_1.lock).toISOString().slice(11, 16);
  await expect(page.getByRole("alert")).toHaveText(
    `Your team locked at ${at}.`,
  );
  await expect(page.getByLabel("Your team LOCKED")).toBeVisible();
  await expect(saveButton(page)).toHaveCount(0);
  // The locked team is the saved one; the draft stays in the browser.
  await expect(teamRow(page, /Sainz/)).toBeVisible();
  expect(await draftKeys(page)).toHaveLength(1);
});

test("the pool changes under an open page: the save is refused with words and the new pool loads", async ({
  page,
  request,
}) => {
  await createTeam(page);
  await buildTeam(page);
  await expect(saveButton(page)).toBeEnabled();

  await withdrawDriver(request, "BEA");
  await saveButton(page).click();
  await expect(page.getByRole("alert")).toHaveText(
    "One of your picks can't be picked any more. Swap it to save.",
  );
  await expect(teamRow(page, /Bearman/)).toContainText("Withdrawn");
  await expect(
    page.getByText("Swap out the pick that can't be picked any more."),
  ).toBeVisible();
  await expect(saveButton(page)).toBeDisabled();
  expect(await draftKeys(page)).toHaveLength(1);

  await swap(page, /Bearman/, /Stroll/);
  await saveTeam(page);
});

/** Presses Tab until `target` has focus. */
async function tabTo(page: Page, target: Locator) {
  for (let i = 0; i < 80; i++) {
    if (await target.evaluate((el) => el === document.activeElement)) return;
    await page.keyboard.press("Tab");
  }
  throw new Error("never reached by Tab");
}

test("the whole builder works with the keyboard alone", async ({ page }) => {
  await createTeam(page);
  const pickWithKeys = async (kind: "driver" | "constructor", name: RegExp) => {
    await tabTo(
      page,
      page.getByRole("button", { name: `Add a ${kind}` }).first(),
    );
    await page.keyboard.press("Enter");
    const sheet = picker(page);
    await expect(sheet).toBeVisible();
    await tabTo(page, sheet.getByRole("button", { name: /^See all/ }));
    await page.keyboard.press("Enter");
    await tabTo(page, sheet.getByRole("button", { name }));
    await page.keyboard.press("Enter");
    await expect(sheet).toBeHidden();
  };
  for (const name of [/Albon/, /Sainz/, /Alonso/, /Hülkenberg/, /Bearman/]) {
    await pickWithKeys("driver", name);
  }
  await pickWithKeys("constructor", /Williams/);
  await pickWithKeys("constructor", /RB F1 Team/);

  await tabTo(page, teamRow(page, /Albon/).getByRole("button"));
  await page.keyboard.press("Enter");
  await tabTo(page, picker(page).getByRole("switch", { name: "2× Boost" }));
  await page.keyboard.press("Space");
  await page.keyboard.press("Escape");
  await expect(picker(page)).toBeHidden();

  await tabTo(page, saveButton(page));
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("status").filter({ hasText: "Team saved" }),
  ).toBeVisible();
});

for (const scheme of ["light", "dark"] as const) {
  test(`axe finds nothing serious, ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await createTeam(page);
    await expectNoSeriousAxeViolations(page);
    await buildTeam(page);
    await expectNoSeriousAxeViolations(page);
    await swapOpen(page, /Bearman/);
    await expectNoSeriousAxeViolations(page);
  });
}

test("Save is disabled until hydrated", async ({ page, browser }) => {
  await createTeam(page);
  await buildTeam(page);
  await saveTeam(page);

  const context = await browser.newContext({
    baseURL: FANTASY_ORIGIN,
    javaScriptEnabled: false,
    viewport: { width: 390, height: 844 },
    storageState: await page.context().storageState(),
  });
  const noScript = await context.newPage();
  await noScript.goto("/team/1");
  await expect(heading(noScript)).toHaveText("Box Box");
  await expect(saveButton(noScript)).toBeDisabled();
  await expect(teamRow(noScript, /Sainz/).getByRole("button")).toBeDisabled();
  await context.close();
});
