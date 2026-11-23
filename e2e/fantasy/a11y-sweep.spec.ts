import { createRequire } from "node:module";
import { expect, test, type Page } from "@playwright/test";
import { createAccount, pageHydrated } from "../helpers/accounts";
import { reportedPost } from "../helpers/forum";
import {
  FANTASY_ORIGIN,
  ROUND_1,
  addCrowd,
  moveClock,
  seedGame,
  teamChangeReview,
} from "../helpers/game";
import { createLeague } from "../helpers/leagues";
import { unlockedAdmin } from "../helpers/staff";
import { buildTeam, createTeam, saveTeam } from "../helpers/team";

// The accessibility sweep (M9 Task 8): every page route in routeTree.gen.ts,
// at 390 and 1440 wide, logged out, as a player with a team, and (staff
// routes) as an admin, runs axe's WCAG 2.1 A and AA rules and fails on any
// violation. Each role starts from its known pages and follows the links it
// finds, so the routes with an id in them are reached the way a person
// reaches them; a route a role should reach and didn't fails the sweep too.

const require = createRequire(import.meta.url);
const WCAG_21_AA = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const WIDTHS = [1440, 390] as const;

/**
 * Every page route (routeTree.gen.ts, less the API routes and the two that
 * only redirect: `/forgot-password` to `/reset-password`, and `/staff` to the
 * first staff screen).
 */
const PAGE_ROUTES = [
  "/",
  "/auth-error",
  "/check-email",
  "/components",
  "/forum",
  "/forum/new",
  "/forum/$category",
  "/leagues",
  "/leagues/new",
  "/leagues/$slug",
  "/legal/$kind",
  "/notifications",
  "/prices",
  "/prices/how",
  "/profile",
  "/reset-password",
  "/settings",
  "/settings/data",
  "/settings/delete",
  "/settings/delete/confirm",
  "/settings/favorites",
  "/settings/security",
  "/settings/sign-in",
  "/settings/username",
  "/sign-in",
  "/sign-up",
  "/sign-up/email",
  "/staff/audit",
  "/staff/calendar",
  "/staff/calendar/$eventId",
  "/staff/moderation",
  "/staff/moderation/$itemId",
  "/staff/prices",
  "/staff/results/$sessionId",
  "/staff/review",
  "/staff/review/$itemId",
  "/staff/scoring",
  "/staff/seats",
  "/staff/settings",
  "/staff/users",
  "/staff/users/$username",
  "/t/$threadId",
  "/team",
  "/team/$slot",
  "/team/$slot/points",
  "/weekend",
  "/welcome",
  "/welcome/favorites",
  "/welcome/spoilers",
] as const;
type PageRoute = (typeof PAGE_ROUTES)[number];

const MATCHERS = PAGE_ROUTES.map((route) => ({
  route,
  dynamic: route.includes("$"),
  re: new RegExp(`^${route.replace(/\$[a-zA-Z]+/g, "[^/]+")}$`),
}));

/** The route a path belongs to; a static route wins over a dynamic one. */
function routeOf(pathname: string): PageRoute | null {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  const hit =
    MATCHERS.find((m) => !m.dynamic && m.re.test(path)) ??
    MATCHERS.find((m) => m.dynamic && m.re.test(path));
  return hit?.route ?? null;
}

type Violation = {
  id: string;
  impact: string | null;
  help: string;
  nodes: { target: string[] }[];
};

/** axe's WCAG 2.1 AA rules on the page as it stands. */
async function axe(page: Page): Promise<Violation[]> {
  const loaded = await page.evaluate(() => "axe" in window);
  if (!loaded) await page.addScriptTag({ path: require.resolve("axe-core") });
  return page.evaluate(
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
}

/**
 * Visits `seeds`, then every in-site link they lead to, keeping the first page
 * of each route in `routes`, and runs axe on it at both widths. Answers the
 * routes it reached and every violation, one line each.
 */
async function sweep(
  page: Page,
  role: string,
  seeds: string[],
  routes: readonly PageRoute[],
) {
  const reached = new Map<PageRoute, string>();
  const found: string[] = [];
  const queue = [...seeds];
  while (queue.length > 0) {
    const href = queue.shift()!;
    const url = new URL(href, FANTASY_ORIGIN);
    const route = routeOf(url.pathname);
    if (!route || !routes.includes(route) || reached.has(route)) continue;
    await page.setViewportSize({ width: WIDTHS[0], height: 900 });
    await page.goto(url.pathname);
    // A redirect lands on another route: that one is checked when it comes.
    if (routeOf(new URL(page.url()).pathname) !== route) continue;
    await pageHydrated(page);
    reached.set(route, url.pathname);
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: width < 768 ? 844 : 900 });
      for (const v of await axe(page)) {
        const where = v.nodes
          .slice(0, 3)
          .map((n) => n.target.join(" "))
          .join(" | ");
        found.push(
          `${role} ${width} ${url.pathname}: ${v.id} (${v.impact}) ${v.help} — ${v.nodes.length} × ${where}`,
        );
      }
    }
    const links = await page.$$eval("a[href]", (as) =>
      as.map((a) => a.getAttribute("href") ?? ""),
    );
    for (const link of links) {
      if (link.startsWith("/") && !link.startsWith("//")) queue.push(link);
    }
  }
  return { reached, found };
}

function expectClean(
  result: { reached: Map<PageRoute, string>; found: string[] },
  routes: readonly PageRoute[],
) {
  expect
    .soft(
      routes.filter((r) => !result.reached.has(r)),
      "routes the sweep didn't reach",
    )
    .toEqual([]);
  expect.soft(result.found, "WCAG 2.1 AA violations").toEqual([]);
}

test.describe.configure({ timeout: 600_000 });

test.beforeEach(async ({ request }) => {
  await seedGame(request, ROUND_1.beforeLock);
});

test("logged out: every public page passes WCAG 2.1 AA at 390 and 1440", async ({
  page,
  browser,
}) => {
  // A thread to read.
  const { threadUrl } = await reportedPost(browser, FANTASY_ORIGIN);
  const routes: PageRoute[] = [
    "/",
    "/auth-error",
    "/check-email",
    "/components",
    "/forum",
    "/forum/$category",
    "/legal/$kind",
    "/prices",
    "/prices/how",
    "/reset-password",
    "/sign-in",
    "/sign-up",
    "/sign-up/email",
    "/t/$threadId",
    "/weekend",
  ];
  const result = await sweep(
    page,
    "logged-out",
    [
      "/",
      "/weekend",
      "/prices",
      "/prices/how",
      "/forum",
      new URL(threadUrl).pathname,
      "/sign-in",
      "/sign-up",
      "/sign-up/email",
      "/forgot-password",
      "/check-email",
      "/reset-password",
      "/auth-error",
      "/legal/terms",
      "/components",
    ],
    routes,
  );
  expectClean(result, routes);
});

test("a player with a team: every signed-in page passes WCAG 2.1 AA at 390 and 1440", async ({
  page,
  request,
  browser,
}) => {
  const { threadUrl } = await reportedPost(browser, FANTASY_ORIGIN);
  const account = await createAccount(page.context().request, {
    origin: FANTASY_ORIGIN,
  });
  // `/team` shows only before the first team; after, it goes to the team.
  const before = await sweep(page, "player", ["/team"], ["/team"]);
  await createTeam(page);
  await buildTeam(page);
  await saveTeam(page);
  await createLeague(page, "Sweep League");
  const routes: PageRoute[] = [
    "/",
    "/forum",
    "/forum/new",
    "/forum/$category",
    "/leagues",
    "/leagues/new",
    "/leagues/$slug",
    "/notifications",
    "/prices",
    "/prices/how",
    "/profile",
    "/settings",
    "/settings/data",
    "/settings/delete",
    "/settings/delete/confirm",
    "/settings/favorites",
    "/settings/security",
    "/settings/sign-in",
    "/settings/username",
    "/t/$threadId",
    "/team",
    "/team/$slot",
    "/team/$slot/points",
    "/weekend",
    "/welcome/favorites",
    "/welcome/spoilers",
  ];
  const seeds = [
    "/",
    "/weekend",
    "/team",
    "/team/1",
    "/team/1/points",
    "/leagues",
    "/leagues/new",
    "/prices",
    "/prices/how",
    "/forum",
    "/forum/new",
    new URL(threadUrl).pathname,
    "/notifications",
    "/profile",
    "/settings",
    "/settings/username",
    "/settings/favorites",
    "/settings/security",
    "/settings/sign-in",
    "/settings/data",
    "/settings/delete",
    "/settings/delete/confirm",
    "/welcome/favorites",
    "/welcome/spoilers",
  ];
  const result = await sweep(page, "player", seeds, routes);

  // Again after round 1's race: a locked team, points, spoiler covers and
  // the race's threads.
  await moveClock(request, ROUND_1.afterRace);
  const race = await sweep(page, "after-race", seeds, routes);

  // An account that hasn't finished signing up sees /welcome.
  const cleared = await page.request.post("/api/test/clear-acceptances", {
    data: { email: account.email },
  });
  expect(cleared.status()).toBe(200);
  const welcome = await sweep(page, "unfinished", ["/welcome"], ["/welcome"]);
  expectClean(
    {
      reached: new Map([
        ...before.reached,
        ...result.reached,
        ...welcome.reached,
      ]),
      found: [
        ...before.found,
        ...result.found,
        ...race.found,
        ...welcome.found,
      ],
    },
    [...routes, "/welcome"],
  );
});

test("an admin: every staff page passes WCAG 2.1 AA at 390 and 1440", async ({
  page,
  request,
  browser,
}) => {
  // Something in each queue: a review item and a reported post.
  await createAccount(page.context().request, { origin: FANTASY_ORIGIN });
  await createTeam(page);
  await buildTeam(page);
  await saveTeam(page);
  await addCrowd(request, 2);
  await teamChangeReview(request, "ALB", "haas");
  await reportedPost(browser, FANTASY_ORIGIN);
  await page.context().clearCookies();
  const admin = await unlockedAdmin(page, request, FANTASY_ORIGIN);

  const routes = PAGE_ROUTES.filter((r) => r.startsWith("/staff"));
  const result = await sweep(
    page,
    "admin",
    [
      "/staff/review",
      "/staff/moderation",
      "/staff/calendar",
      "/staff/seats",
      "/staff/scoring",
      "/staff/prices",
      "/staff/users",
      `/staff/users/${admin.username}`,
      "/staff/settings",
      "/staff/audit",
    ],
    routes,
  );
  expectClean(result, routes);
});
