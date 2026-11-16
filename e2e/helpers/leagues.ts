import { expect, type Page } from "@playwright/test";
import { heading, hydrated } from "./accounts";

/** Creates a league from /leagues/new and answers its code. */
export async function createLeague(page: Page, name: string) {
  await page.goto("/leagues/new");
  const create = page.getByRole("button", { name: "Create league" });
  await hydrated(create);
  await page.getByLabel("League name").fill(name);
  await create.click();
  await expect(heading(page)).toHaveText(name);
  const code = await page
    .getByRole("group", { name: "Invite with code" })
    .locator("[data-join-code]")
    .textContent();
  expect(code).toMatch(/^[A-Z2-9]{10}$/);
  return code!;
}
