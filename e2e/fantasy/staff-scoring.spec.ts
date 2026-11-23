import { expect, test } from "@playwright/test";
import {
  createAccount,
  expectNoSeriousAxeViolations,
  heading,
  hydrated,
} from "../helpers/accounts";
import {
  addCrowd,
  FANTASY_ORIGIN,
  moveClock,
  ROUND_1,
  runDueNow,
  seedGame,
  staleOverride,
} from "../helpers/game";
import { unlockedAdmin } from "../helpers/staff";
import { buildTeam, createTeam, saveTeam } from "../helpers/team";

// The scoring dry run (M8 Task 8) on the seeded 2026 game: "Box Box" and a
// small crowd scored through round 1's race, then Albon disqualified with
// nothing re-scored (the harness's stale override), so a dry run has a change
// to show. It's approved, and the audit log has both. At the plan's two sizes.

test.beforeEach(async ({ page, request }) => {
  await seedGame(request, ROUND_1.beforeLock);
  await createAccount(page.context().request, { origin: FANTASY_ORIGIN });
  await createTeam(page);
  await buildTeam(page);
  await saveTeam(page);
  await addCrowd(request, 2);
  await moveClock(request, ROUND_1.afterRace);
});

for (const size of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
]) {
  test(`run a dry run, see the tiles and biggest changes, approve it, and the audit log has both (${size.name})`, async ({
    page,
    request,
  }) => {
    test.setTimeout(240_000);
    await page.setViewportSize(size);
    // The player from beforeEach signs out; an admin signs in.
    await page.context().clearCookies();
    await unlockedAdmin(page, request, FANTASY_ORIGIN);

    // Albon disqualified from the race, with nothing re-scored yet.
    await staleOverride(request, "ALB");

    // A dry run.
    await page.goto("/staff/scoring");
    await expect(heading(page)).toHaveText("Scoring");
    const start = page.getByRole("form", { name: "START A DRY RUN" });
    await hydrated(start.getByRole("button", { name: "Start a dry run" }));
    await start
      .getByLabel("Reason (saved in the audit log)")
      .fill("Check Albon's disqualification");
    await start.getByRole("button", { name: "Start a dry run" }).click();

    await expect(heading(page)).toHaveText("Scoring dry run");
    await expect(
      page.getByText("SCORING · DRY RUN · NOTHING HAS CHANGED YET"),
    ).toBeVisible();
    // It scores as jobs (M9 Task 7), so it shows as running until they run.
    await expect(
      page.getByText("This dry run is still scoring. Reload in a minute."),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Approve and re-score" }),
    ).toBeDisabled();
    await runDueNow(request);
    await page.reload();
    const tiles = page.getByRole("list", { name: "Dry run totals" });
    await expect(tiles.locator('[data-slot="dry-run-tile"]')).toHaveCount(4);
    await expect(tiles).toContainText("TEAMS AFFECTED");
    await expect(tiles).toContainText("of 3");
    await expect(tiles).toContainText("Round 1");
    const biggest = page.getByRole("table", { name: "Biggest changes" });
    await expect(
      biggest
        .locator('[data-slot="dry-run-row"]')
        .filter({ hasText: "Box Box" }),
    ).toContainText("Round 1");
    await expect(
      page.getByText(/Points change in round 1\. Prices aren't changed\./),
    ).toBeVisible();
    await expect(
      page.getByRole("list", { name: "Ruleset versions" }),
    ).toContainText("Version 1");
    await expectNoSeriousAxeViolations(page);

    // Approve it.
    const decide = page.getByRole("form", {
      name: "Approve or discard the dry run",
    });
    await decide
      .getByLabel("Reason (saved in the audit log)")
      .fill("The changes match the stewards' decision");
    await decide.getByRole("button", { name: "Approve and re-score" }).click();
    await expect(
      page.getByText(
        /The last dry run was approved, and its re-score is queued/,
      ),
    ).toBeVisible();

    // Both are in the audit log.
    await page.goto("/staff/audit");
    const log = page.locator("main");
    await expect(log).toContainText("Scoring dry run");
    await expect(log).toContainText("Re-score approved");
    await expect(log).toContainText("Check Albon's disqualification");
  });
}
