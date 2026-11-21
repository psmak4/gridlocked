import { expect, test } from "@playwright/test";
import {
  expectNoSeriousAxeViolations,
  heading,
  hydrated,
} from "../helpers/accounts";
import {
  FANTASY_ORIGIN,
  moveClock,
  ROUND_1,
  seedGame,
  teamChangeReview,
} from "../helpers/game";
import { unlockedAdmin } from "../helpers/staff";

// The review queue (M8 Task 10) on the seeded 2026 game after round 1's race:
// a team change the roster check would find for round 2 (Albon seen at Haas,
// whose seat began at round 1) is resolved
// with "Update seats from this event on", and moves to Resolved with its
// reason. At the plan's two sizes.

test.beforeEach(async ({ request }) => {
  await seedGame(request, ROUND_1.beforeLock);
  await moveClock(request, ROUND_1.afterRace);
  await teamChangeReview(request, "ALB", "haas");
});

for (const size of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
]) {
  test(`resolve a team change from the queue, and it moves to Resolved with its reason (${size.name})`, async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize(size);
    await unlockedAdmin(page, request, FANTASY_ORIGIN);

    await page.goto("/staff/review");
    await expect(heading(page)).toHaveText("Review queue");
    const open = page.getByRole("list", { name: "Open items" });
    const change = open
      .locator('[data-slot="review-item"]')
      .filter({ hasText: /Albon is at Haas/ });
    await expect(change).toHaveCount(1);
    await expectNoSeriousAxeViolations(page);

    await change.getByRole("link").click();
    const panel = page.locator('[data-slot="review-panel"]');
    await expect(
      panel.getByRole("heading", { name: /Albon is at Haas/ }),
    ).toBeVisible();
    await expect(panel.getByText("EVIDENCE")).toBeVisible();
    await expect(panel).toContainText("Our seats say");
    await expect(
      panel.getByText("Scoring isn't held: this is a warning."),
    ).toBeVisible();
    await expect(
      panel.getByRole("link", { name: "Go to Drivers and seats" }),
    ).toBeVisible();
    await expectNoSeriousAxeViolations(page);

    const update = panel.getByRole("button", {
      name: "Update seats from this event on",
    });
    await hydrated(update);
    await panel
      .getByLabel("Reason (saved in the audit log)")
      .fill("Albon moves to Haas for the season");
    await update.click();
    await expect(
      panel.getByText(
        "Update seats from this event on: done. It's in Resolved now.",
      ),
    ).toBeVisible();
    await expect(change).toHaveCount(0);

    await page.getByRole("link", { name: "Resolved", exact: true }).click();
    const done = page
      .getByRole("list", { name: "Resolved items" })
      .locator('[data-slot="review-item"]')
      .filter({ hasText: /Albon is at Haas/ });
    await expect(done).toContainText("Update seats from this event on");
    await expect(done).toContainText("“Albon moves to Haas for the season”");

    await page.goto("/staff/audit");
    const log = page.locator("main");
    await expect(log).toContainText("Review item resolved");
    await expect(log).toContainText("Seat");
  });
}
