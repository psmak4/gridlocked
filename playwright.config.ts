import { defineConfig } from "@playwright/test";

const PORT = 3100;
/** The fantasy project's own server: the same build, in replay mode. */
const FANTASY_PORT = 3101;

export default defineConfig({
  testDir: "e2e",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    viewport: { width: 390, height: 844 },
  },
  projects: [
    {
      name: "chromium",
      testIgnore: "fantasy/**",
      use: { browserName: "chromium", baseURL: `http://localhost:${PORT}` },
    },
    {
      // The fantasy screens move the simulated clock (e2e/helpers/game.ts),
      // and the server has one, so its specs run one at a time on a server
      // of their own. CI runs it as its own step.
      name: "fantasy",
      testDir: "e2e/fantasy",
      workers: 1,
      use: {
        browserName: "chromium",
        baseURL: `http://localhost:${FANTASY_PORT}`,
      },
    },
  ],
  // Started in order, so locally the first one's build is done before the
  // second starts.
  webServer: [
    {
      // CI builds before running e2e; locally, build first so the run is self-contained.
      // The Nitro server reads its port from PORT. VITE_LOCAL_DB=1 builds the
      // server with an in-memory PGlite for the auth routes; CI sets it on its
      // build step, and a deployed build never does.
      command: process.env.CI
        ? "pnpm start"
        : "VITE_LOCAL_DB=1 pnpm build && pnpm start",
      env: { PORT: String(PORT) },
      url: `http://localhost:${PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
    },
    {
      // The same flagged build, with "now" read from the simulated clock,
      // which `/api/test/game` sets and `/api/test/clock` moves.
      command: "pnpm start",
      env: { PORT: String(FANTASY_PORT), CLOCK_MODE: "replay" },
      url: `http://localhost:${FANTASY_PORT}`,
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
    },
  ],
});
