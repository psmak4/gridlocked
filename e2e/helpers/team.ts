import { expect, type Browser, type Page } from "@playwright/test";
import { hydrated } from "./accounts";
import { FANTASY_ORIGIN } from "./game";

// The team builder's steps, shared by the fantasy specs. Prices are our own
// (tests/fixtures/prices-2026.json), in $M at round 1: Norris 28.0,
// Verstappen 27.0, Piastri 25.0, Russell 22.0, Albon 13.5, Sainz 12.0,
// Alonso 11.0, Hülkenberg 9.5, Bearman 8.0, Stroll 6.0, Gasly 5.2, Bottas
// 3.6, Lindblad 3.2; Williams 17.0, RB F1 Team 13.0, Haas 9.0, Alpine 6.0,
// Cadillac 4.0. The cap is $100M.

export const saveButton = (page: Page) =>
  page.getByRole("button", { name: "Save team" });
export const picker = (page: Page) => page.getByRole("dialog");
/** The constructors this spec uses; every other name is a driver. */
export const CONSTRUCTOR = /Williams|F1 Team/;

/**
 * A picked row, in its own section: a driver row's subtitle names its
 * constructor, and a constructor row's names its drivers, so a name alone
 * would match both.
 */
export const teamRow = (page: Page, name: RegExp) =>
  page
    .getByRole("region", {
      name: CONSTRUCTOR.test(name.source) ? "CONSTRUCTORS" : "DRIVERS",
    })
    .locator("li[data-asset-id]")
    .filter({ hasText: name });

/** Creates "Box Box" and lands in its builder, hydrated. */
export async function createTeam(page: Page) {
  await page.goto("/team");
  const create = page.getByRole("button", { name: "Create a team" });
  await hydrated(create);
  await page.getByLabel("Team name").fill("Box Box");
  await create.click();
  await expect(page).toHaveURL("/team/1");
  await hydrated(page.getByRole("button", { name: "Add a driver" }).first());
}

/** Picks `name` in the open picker, from all of the pool. */
export async function choose(page: Page, name: RegExp) {
  const sheet = picker(page);
  await expect(sheet.getByRole("list")).toBeVisible();
  const all = sheet.getByRole("button", { name: /^See all/ });
  if (await all.isVisible()) await all.click();
  await sheet.getByRole("button", { name }).click();
  await expect(sheet).toBeHidden();
}

/** Fills an empty slot. */
export async function add(
  page: Page,
  kind: "driver" | "constructor",
  name: RegExp,
) {
  await page
    .getByRole("button", { name: `Add a ${kind}` })
    .first()
    .click();
  await choose(page, name);
}

/** Opens a picked row's picker and swaps it for `into`. */
export async function swap(page: Page, out: RegExp, into: RegExp) {
  await teamRow(page, out).getByRole("button").click();
  await choose(page, into);
}

/** Puts the 2× Boost on a picked driver. */
export async function boost(page: Page, name: RegExp) {
  await teamRow(page, name).getByRole("button").click();
  const sheet = picker(page);
  await sheet.getByRole("switch", { name: "2× Boost" }).click();
  await sheet.getByRole("button", { name: "Cancel" }).click();
  await expect(sheet).toBeHidden();
}

/** Albon (Boost), Sainz, Alonso, Hülkenberg, Bearman; Williams, RB F1 Team: $84.0M. */
export async function buildTeam(page: Page) {
  for (const name of [/Albon/, /Sainz/, /Alonso/, /Hülkenberg/, /Bearman/]) {
    await add(page, "driver", name);
  }
  await add(page, "constructor", /Williams/);
  await add(page, "constructor", /RB F1 Team/);
  await boost(page, /Albon/);
}

export async function saveTeam(page: Page) {
  await saveButton(page).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Team saved" }),
  ).toBeVisible();
}

/** A second device: a new browser context signed in as the same account. */
export async function secondDevice(browser: Browser, page: Page) {
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
