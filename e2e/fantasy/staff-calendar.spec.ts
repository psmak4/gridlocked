import { expect, test } from "@playwright/test";
import {
  expectNoSeriousAxeViolations,
  heading,
  hydrated,
} from "../helpers/accounts";
import { FANTASY_ORIGIN, ROUND_1, ROUND_2, seedGame } from "../helpers/game";
import { unlockedAdmin } from "../helpers/staff";

// The staff calendar (M8 Task 5) on the seeded 2026 game, a day before
// round 1 locks: round 2's lock is moved by hand, then put back on its
// session, and History shows both. At the plan's two sizes.

test.beforeEach(async ({ request }) => {
  await seedGame(request, ROUND_1.beforeLock);
});

/** A `datetime-local` value, in UTC. */
const utcInput = (ms: number) => new Date(ms).toISOString().slice(0, 16);
const HOUR_MS = 3_600_000;

for (const size of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
]) {
  test(`move a lock by hand, then follow the session again, and both show in History (${size.name})`, async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize(size);
    await unlockedAdmin(page, request, FANTASY_ORIGIN);

    await page.goto("/staff");
    await expect(page).toHaveURL("/staff/calendar");
    await expect(heading(page)).toHaveText("2026 calendar");
    await expect(page.getByText(/times in UTC/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Sync now" })).toBeVisible();

    await page.getByRole("link", { name: /^Chinese Grand Prix/ }).click();
    await expect(page).toHaveURL(/\/staff\/calendar\/[0-9a-f-]{36}$/);
    const panel = page.getByRole("region", { name: "Chinese Grand Prix" });
    await expect(panel.getByText("EDITING · ROUND 2")).toBeVisible();
    const lock = panel.getByRole("form", {
      name: "Lock for Chinese Grand Prix",
    });
    await expect(lock.getByText("Team locks at the start of")).toBeVisible();
    await expect(lock.getByText(/^Sprint Qualifying · /)).toBeVisible();

    // By hand, an hour early.
    await hydrated(lock.getByRole("button", { name: "Save changes" }));
    await lock
      .getByRole("switch", { name: "Set the lock time by hand" })
      .click();
    await lock
      .getByLabel("Lock time (UTC)")
      .fill(utcInput(Date.parse(ROUND_2.lock) - HOUR_MS));
    await lock
      .getByLabel("Reason (saved in the audit log)")
      .fill("FIA moved sprint qualifying");
    await lock.getByRole("button", { name: "Save changes" }).click();
    const history = panel.getByRole("list", { name: "History" });
    await expect(history.getByRole("listitem")).toHaveCount(1);
    await expect(history).toContainText("Lock time change");
    await expect(history).toContainText("lockAtSource: default → admin");
    await expect(history).toContainText("“FIA moved sprint qualifying”");
    await expect(
      page.getByRole("link", { name: /^Chinese Grand Prix.*lock set by hand/ }),
    ).toBeVisible();

    // Back on the session.
    await lock
      .getByRole("switch", { name: "Set the lock time by hand" })
      .click();
    await lock
      .getByLabel("Reason (saved in the audit log)")
      .fill("Back to the schedule");
    await lock.getByRole("button", { name: "Save changes" }).click();
    await expect(history.getByRole("listitem")).toHaveCount(2);
    await expect(history.getByRole("listitem").first()).toContainText(
      "lockAtSource: admin → default",
    );
    await expect(history.getByRole("listitem").first()).toContainText(
      "“Back to the schedule”",
    );
    await expect(
      page.getByRole("link", { name: /lock set by hand/ }),
    ).toHaveCount(0);

    await expectNoSeriousAxeViolations(page);
  });
}
