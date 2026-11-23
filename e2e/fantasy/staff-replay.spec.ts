import { expect, test } from "@playwright/test";
import {
  expectNoSeriousAxeViolations,
  heading,
  hydrated,
} from "../helpers/accounts";
import { FANTASY_ORIGIN, ROUND_1, seedGame } from "../helpers/game";
import { unlockedAdmin } from "../helpers/staff";

// The replay clock on Settings (M9 Task 5), on the fantasy server, which runs
// in replay mode: an hour before round 1 locks, an admin starts the clock,
// pauses it, and jumps past the lock, which stops a minute short of it. Each
// move is in the audit log with its reason. Seeding the next spec resets the
// database, offset and all.

test.beforeEach(async ({ request }) => {
  await seedGame(request, ROUND_1.beforeLock);
});

/** "6 Mar, 10:30 UTC", as the screen says an instant. */
const utcWords = (iso: string) => {
  const at = new Date(iso);
  const day = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(at);
  return `${day}, ${iso.slice(11, 16)} UTC`;
};

test("an admin pauses the replay and resumes it, both in the audit log", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  await unlockedAdmin(page, request, FANTASY_ORIGIN);
  await page.goto("/staff/settings");
  await expect(heading(page)).toHaveText("Settings");

  const clock = page.getByRole("form", { name: "Replay clock" });
  const state = clock.locator('[data-slot="replay-state"]');
  // No offset yet: the clock stands where the seed put it.
  await expect(state).toHaveText(`Paused at ${utcWords(ROUND_1.beforeLock)}.`);
  await expectNoSeriousAxeViolations(page);

  const tag = Math.random().toString(36).slice(2, 8);
  const reason = clock.getByLabel("Reason (saved in the audit log)");
  const resume = clock.getByRole("button", { name: "Resume the replay" });
  await hydrated(resume);
  // A reason is required.
  await resume.click();
  await expect(clock.getByText("Give a reason")).toBeVisible();
  await reason.fill(`Start the beta weekend ${tag}`);
  await resume.click();
  await expect(clock.getByRole("status")).toHaveText(
    `Running again from ${utcWords(ROUND_1.beforeLock)}. It's in the audit log.`,
  );
  await expect(state).toContainText("Running. The replay stands at");

  await reason.fill(`Break between sessions ${tag}`);
  await clock.getByRole("button", { name: "Pause the replay" }).click();
  await expect(clock.getByRole("status")).toContainText("Paused at");
  await expect(state).toContainText("Paused at");

  // Past the lock: it stops a minute before it.
  await clock
    .getByLabel("Jump to (UTC)")
    .fill(
      new Date(Date.parse(ROUND_1.lock) + 3_600_000).toISOString().slice(0, 16),
    );
  await reason.fill(`Skip to the lock ${tag}`);
  await clock.getByRole("button", { name: "Jump" }).click();
  const stop = new Date(Date.parse(ROUND_1.lock) - 60_000).toISOString();
  await expect(clock.getByRole("status")).toHaveText(
    `Stopped at ${utcWords(stop)}, a minute before the next lock. It's in the audit log.`,
  );
  await expect(state).toHaveText(`Paused at ${utcWords(stop)}.`);

  await page.goto("/staff/audit");
  const rows = page
    .getByRole("row")
    .filter({ hasText: "Setting changed" })
    .filter({ hasText: tag });
  await expect(rows).toHaveCount(3);
  await expect(
    rows.filter({ hasText: "Start the beta weekend" }),
  ).toContainText("mode: paused → running");
  await expect(
    rows.filter({ hasText: "Break between sessions" }),
  ).toContainText("mode: running → paused");
});
