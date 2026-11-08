import { defineConfig } from "@playwright/test";

const PORT = 3100;

export default defineConfig({
  testDir: "e2e",
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 390, height: 844 },
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: {
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
});
