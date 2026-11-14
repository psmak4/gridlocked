import { expect, test, type Locator } from "@playwright/test";
import { expectNoSeriousAxeViolations } from "./helpers/accounts";

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
  test("touch targets of the second set are at least 44 px", async ({
    page,
  }) => {
    for (const tab of await page.getByRole("tab").all()) {
      expect(await height(tab)).toBeGreaterThanOrEqual(44);
    }
    for (const link of await page
      .getByRole("navigation", { name: "Main" })
      .getByRole("link")
      .all()) {
      expect(await height(link)).toBeGreaterThanOrEqual(44);
    }
    expect(
      await height(page.getByRole("button", { name: /NORRIS/i })),
    ).toBeGreaterThanOrEqual(56);
    expect(
      await height(page.getByRole("button", { name: "Show it" })),
    ).toBeGreaterThanOrEqual(44);
    expect(
      await height(page.getByRole("button", { name: "Mark as watched" })),
    ).toBeGreaterThanOrEqual(44);
    await page.getByRole("button", { name: "Open the chip sheet" }).click();
    expect(
      await height(page.getByRole("button", { name: "Cancel" })),
    ).toBeGreaterThanOrEqual(44);
  });

  test("Tabs move with the arrow keys", async ({ page }) => {
    const drivers = page.getByRole("tab", { name: "Drivers" });
    const constructors = page.getByRole("tab", { name: "Constructors" });
    await expect(drivers).toHaveAttribute("aria-selected", "true");
    await drivers.focus();
    await page.keyboard.press("ArrowRight");
    await expect(constructors).toBeFocused();
    await expect(constructors).toHaveAttribute("aria-selected", "true");
    await expect(drivers).toHaveAttribute("aria-selected", "false");
    await page.keyboard.press("ArrowLeft");
    await expect(drivers).toBeFocused();
    await expect(drivers).toHaveAttribute("aria-selected", "true");
  });

  test("Sheet closes on Cancel and Escape, and traps focus while open", async ({
    page,
  }) => {
    const open = page.getByRole("button", { name: "Open the chip sheet" });
    const sheet = page.getByRole("dialog", { name: "Play Overdrive" });
    await open.click();
    await expect(sheet).toBeVisible();
    // Base UI's focus guards hand focus back a moment after a Tab, so poll.
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      await expect
        .poll(
          () => sheet.evaluate((el) => el.contains(document.activeElement)),
          { message: `focus stays in the sheet after ${i + 1} tabs` },
        )
        .toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
    await expect(open).toBeFocused();

    await open.click();
    await expect(sheet).toBeVisible();
    await sheet.getByRole("button", { name: "Cancel" }).click();
    await expect(sheet).toBeHidden();
  });

  test("Sheet closes on a swipe down from its grab handle", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Open the chip sheet" }).click();
    const sheet = page.getByRole("dialog", { name: "Play Overdrive" });
    await expect(sheet).toBeVisible();
    const handle = await sheet
      .locator('[data-slot="sheet-grab"]')
      .boundingBox();
    expect(handle).not.toBeNull();
    const x = (handle?.x ?? 0) + (handle?.width ?? 0) / 2;
    const y = (handle?.y ?? 0) + (handle?.height ?? 0) / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + 60, { steps: 4 });
    await page.mouse.move(x, y + 140, { steps: 4 });
    await page.mouse.up();
    await expect(sheet).toBeHidden();
  });

  test("Sheet is a bottom sheet on a phone and a centered dialog from 1024 px", async ({
    page,
  }) => {
    await page.getByRole("button", { name: "Open the chip sheet" }).click();
    const sheet = page.getByRole("dialog", { name: "Play Overdrive" });
    // Measured once the slide-in has finished.
    await expect(async () => {
      const phone = await sheet.boundingBox();
      expect(phone).not.toBeNull();
      expect(Math.round((phone?.y ?? 0) + (phone?.height ?? 0))).toBe(844);
      expect(phone?.width).toBe(390);
    }).toPass();

    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(async () => {
      const desk = await sheet.boundingBox();
      expect(desk).not.toBeNull();
      const left = desk?.x ?? 0;
      const right = 1280 - left - (desk?.width ?? 0);
      expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
      expect(desk?.width).toBeLessThan(1280);
      expect((desk?.y ?? 0) + (desk?.height ?? 0)).toBeLessThan(800);
    }).toPass();
  });

  test("SpoilerCover's Show it reveals what it covers", async ({ page }) => {
    const cover = page.locator('[data-slot="spoiler-cover"]');
    await expect(cover).toContainText("Race — results are in");
    await expect(page.getByText("44 pts")).toHaveCount(0);
    await page.getByRole("button", { name: "Show it" }).click();
    await expect(page.getByText("44 pts")).toBeVisible();
    await expect(cover).toHaveCount(0);
  });

  test("a focused Toast dismisses after the window loses focus", async ({
    page,
  }) => {
    const toast = page.getByRole("status").filter({ hasText: "Team saved" });
    await page.getByRole("button", { name: "Undo" }).focus();
    await page.waitForTimeout(4600);
    await expect(toast).toBeVisible();
    // The person switches apps: the button keeps focus, but the window doesn't.
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect(toast).toBeHidden({ timeout: 6000 });
  });

  for (const scheme of ["light", "dark"] as const) {
    test(`an axe check finds nothing serious (${scheme})`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await expectNoSeriousAxeViolations(page);
      await page.getByRole("button", { name: "Open the chip sheet" }).click();
      await expect(
        page.getByRole("dialog", { name: "Play Overdrive" }),
      ).toBeVisible();
      await expectNoSeriousAxeViolations(page);
    });
  }
});

test.describe("components on a touch screen", () => {
  test.use({ hasTouch: true });

  test("a touch tap doesn't pause the Toast", async ({ page }) => {
    await page.goto("/components");
    await expect(page.getByRole("button", { name: "Save team" })).toBeEnabled();
    const toast = page.getByRole("status").filter({ hasText: "Team saved" });
    await toast.getByText("Team saved").tap();
    await expect(toast).toBeHidden({ timeout: 6000 });
  });
});
