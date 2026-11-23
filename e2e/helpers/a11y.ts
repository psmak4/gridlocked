import { expect, type Locator, type Page } from "@playwright/test";
import { injectAxe } from "./accounts";

// Accessibility checks shared by the sweep and the keyboard pass (M9 Task 8).

const WCAG_21_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

type Violation = {
  id: string;
  impact: string | null;
  help: string;
  nodes: { target: string[] }[];
};

/** axe's WCAG 2.1 A and AA rules on the page as it stands, one line each. */
export async function wcagViolations(page: Page): Promise<string[]> {
  await injectAxe(page);
  const violations = await page.evaluate(
    async (tags) =>
      (
        await (
          window as unknown as {
            axe: {
              run: (
                context: Document,
                options: unknown,
              ) => Promise<{ violations: Violation[] }>;
            };
          }
        ).axe.run(document, { runOnly: { type: "tag", values: tags } })
      ).violations,
    WCAG_21_AA,
  );
  return violations.map((v) => {
    const where = v.nodes
      .slice(0, 3)
      .map((n) => n.target.join(" "))
      .join(" | ");
    return `${v.id} (${v.impact}) ${v.help} — ${v.nodes.length} × ${where}`;
  });
}

/**
 * `target` shows a focus ring: an outline or a box shadow while focused.
 * Polled briefly: under a loaded full run, a sheet that is still opening can
 * settle its styles a moment after focus arrives.
 */
export async function expectFocusRing(target: Locator) {
  await expect
    .poll(
      () =>
        target.evaluate((el) => {
          const s = getComputedStyle(el);
          const outline =
            s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0;
          return outline || s.boxShadow !== "none";
        }),
      { message: "a visible focus ring", timeout: 2_000 },
    )
    .toBe(true);
}

/**
 * Presses Tab (Shift+Tab with `back`) until `target` has focus, at most `max`
 * times, then checks its focus ring: the control is reachable in the tab
 * order and shows where focus is.
 */
export async function tabTo(
  page: Page,
  target: Locator,
  { max = 80, back = false }: { max?: number; back?: boolean } = {},
) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press(back ? "Shift+Tab" : "Tab");
    if (await target.evaluate((el) => el === document.activeElement)) {
      await expectFocusRing(target);
      return;
    }
  }
  throw new Error(`Tab never reached ${target.toString()}`);
}
