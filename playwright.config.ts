import { defineConfig } from "@playwright/test";

const PORT = 3100;
// Spike: SPIKE_BASE_URL points the e2e at a deployed host instead of a local server.
const SPIKE_BASE_URL = process.env.SPIKE_BASE_URL;

export default defineConfig({
  testDir: "e2e",
  // Spike specs need a VITE_SPIKE_LOCAL build and a secret: SPIKE_E2E=1 runs them.
  testIgnore: process.env.SPIKE_E2E ? [] : ["spike/**"],
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: SPIKE_BASE_URL ?? `http://localhost:${PORT}`,
    viewport: { width: 390, height: 844 },
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: SPIKE_BASE_URL
    ? undefined
    : {
        // CI builds before running e2e; locally, build first so the run is self-contained.
        // The Nitro server reads its port from PORT.
        command: process.env.CI ? "pnpm start" : "pnpm build && pnpm start",
        env: { PORT: String(PORT) },
        url: `http://localhost:${PORT}`,
        reuseExistingServer: !process.env.CI,
        timeout: 300_000,
      },
});
