import { expect, test, type Locator } from "@playwright/test";

const height = async (locator: Locator) => {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box?.height ?? 0;
};

test.describe("components", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/components");
    await expect(page.getByRole("button", { name: "Save team" })).toBeEnabled();
  });

  test("clicking the Checkbox label toggles it", async ({ page }) => {
    const checkbox = page.getByRole("checkbox", { name: "I accept the terms" });
    await expect(checkbox).not.toBeChecked();
    await page.getByText("I accept the terms").click();
    await expect(checkbox).toBeChecked();
  });

  test("clicking the Switch label toggles it", async ({ page }) => {
    const toggle = page.getByRole("switch");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await page.getByText("Hide results until I've watched").click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
  });

  test("the Toast stays while its action is focused, then goes", async ({
    page,
  }) => {
    const toast = page.getByRole("status").filter({ hasText: "Team saved" });
    await page.getByRole("button", { name: "Undo" }).focus();
    await page.waitForTimeout(4600);
    await expect(toast).toBeVisible();
    // Hover in and out while still focused: it must not dismiss.
    await toast.hover();
    await page.mouse.move(0, 0);
    await page.waitForTimeout(500);
    await expect(toast).toBeVisible();
    await page.getByLabel("Team name").focus();
    await expect(toast).toBeHidden({ timeout: 8000 });
  });

  test("hover alone holds the Toast, and leaving restarts the full timer", async ({
    page,
  }) => {
    const toast = page.getByRole("status").filter({ hasText: "Team saved" });
    await expect(toast).toBeVisible();
    await toast.hover();
    await expect(page.getByRole("button", { name: "Undo" })).not.toBeFocused();
    await page.waitForTimeout(4600);
    await expect(toast).toBeVisible();
    await page.mouse.move(0, 0);
    // The timer starts over: still there 2 s later, gone within 4 s of leaving.
    await page.waitForTimeout(2000);
    await expect(toast).toBeVisible();
    await expect(toast).toBeHidden({ timeout: 3000 });
  });

  test("touch targets are at least 44 px", async ({ page }) => {
    expect(
      await height(page.getByRole("button", { name: "Save team" })),
    ).toBeGreaterThanOrEqual(44);
    expect(await height(page.getByLabel("Team name"))).toBeGreaterThanOrEqual(
      44,
    );
    expect(
      await height(page.locator('[data-slot="switch-row"]')),
    ).toBeGreaterThanOrEqual(44);
    expect(
      await height(page.locator('[data-slot="checkbox-row"]')),
    ).toBeGreaterThanOrEqual(44);
  });
});
