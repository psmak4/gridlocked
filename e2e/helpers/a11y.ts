import { createRequire } from "node:module";
import { expect, type Locator, type Page } from "@playwright/test";

// Accessibility checks shared by the sweep and the keyboard pass (M9 Task 8).

const require = createRequire(import.meta.url);
const WCAG_21_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

type Violation = {
  id: string;
  impact: string | null;
  help: string;
  nodes: { target: string[] }[];
};

/** axe's WCAG 2.1 A and AA rules on the page as it stands, one line each. */
export async function wcagViolations(page: Page): Promise<string[]> {
  const loaded = await page.evaluate(() => "axe" in window);
  if (!loaded) await page.addScriptTag({ path: require.resolve("axe-core") });
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

/** `target` shows a focus ring: an outline or a box shadow while focused. */
export async function expectFocusRing(target: Locator) {
  const ring = await target.evaluate((el) => {
    const s = getComputedStyle(el);
    const outline = s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0;
    return outline || s.boxShadow !== "none";
  });
  expect(ring, "a visible focus ring").toBe(true);
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
