import { expect, test, type Page } from "@playwright/test";
import {
  expectNoSeriousAxeViolations,
  heading,
  hydrated,
  ownAddress,
} from "./helpers/accounts";
import { unlockedAdmin } from "./helpers/staff";

// Settings (M8 Task 13): the chat switch, with a reason, lands in the audit
// log as On → Off.

test.beforeEach(async ({ page }) => {
  await ownAddress(page);
});

async function saveWith(page: Page, reason: string) {
  await page.getByLabel("Reason (saved in the audit log)").fill(reason);
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Saved. It's in the audit log.",
  );
}

test("turn chat off with a reason, and the audit log shows On → Off with it", async ({
  page,
  request,
}) => {
  await unlockedAdmin(page, request);
  await page.goto("/staff/settings");
  await expect(heading(page)).toHaveText("Settings");
  await expect(
    page.getByText("Admins only. Every change goes in the audit log."),
  ).toBeVisible();
  // Real time here: no replay clock to move (M9 Task 5).
  await expect(page.getByRole("form", { name: "Replay clock" })).toHaveCount(0);
  const locked = page.locator('[data-slot="locked-feature"]');
  await expect(locked).toHaveCount(2);
  await expect(locked.first()).toContainText("Notification emails");
  await expect(page.getByLabel("First check (min)")).toHaveValue("5");
  // No usage reading has been taken on this server.
  const meters = page.locator('[data-slot="usage-meter"]');
  await expect(meters).toHaveCount(4);
  await expect(meters.first()).toContainText("No reading yet");
  await expect(meters.last()).toContainText("Account emails today");
  await expectNoSeriousAxeViolations(page);

  const chat = page.getByRole("switch", { name: "Live chat" });
  await hydrated(chat);
  await expect(chat).toBeChecked();
  // A reason is required.
  await chat.click();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Give a reason")).toBeVisible();
  const reason = `Chat flood ${Math.random().toString(36).slice(2, 8)}`;
  await saveWith(page, reason);
  await expect(chat).not.toBeChecked();

  await page.goto("/staff/audit");
  const row = page
    .getByRole("row")
    .filter({ hasText: "Setting changed" })
    .filter({ hasText: reason });
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("chat: On → Off");

  // Back on, so this server's other specs keep their chat.
  await page.goto("/staff/settings");
  const again = page.getByRole("switch", { name: "Live chat" });
  await hydrated(again);
  await again.click();
  await saveWith(page, "Back on after the test");
  await expect(again).toBeChecked();
});
