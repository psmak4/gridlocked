import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests that create a test database. Everything else stays in the fast
// "unit" project.
const dbTests = [
  "src/db/**/*.test.{ts,tsx}",
  "src/identity/**/*.test.{ts,tsx}",
  "src/server/**/*.test.{ts,tsx}",
  // The game and play tests mostly build a game (some replay a season), so
  // they need the database limits too; a 10 s hook timed out on CI.
  "src/game/**/*.test.{ts,tsx}",
  "src/play/**/*.test.{ts,tsx}",
  "src/lib/resolve-clock.test.ts",
  "src/audit/**/*.test.{ts,tsx}",
  "src/staff/**/*.test.{ts,tsx}",
  "src/jobs/**/*.test.{ts,tsx}",
  "src/leagues/**/*.test.{ts,tsx}",
  "src/settings/**/*.test.{ts,tsx}",
  "src/spoilers/**/*.test.{ts,tsx}",
  "src/community/**/*.test.{ts,tsx}",
  "src/notifications/**/*.test.{ts,tsx}",
  "src/reference/**/*.test.{ts,tsx}",
  "src/results/**/*.test.{ts,tsx}",
  "src/providers/snapshots.test.ts",
  "src/providers/import/**/*.test.{ts,tsx}",
  "src/providers/http/client.test.ts",
  "src/providers/jolpica/normalize-session.test.ts",
  "src/providers/openf1/participants.test.ts",
  "src/providers/pipeline/**/*.test.{ts,tsx}",
  "src/providers/openf1/roster-check.e2e.test.ts",
  "src/replay/**/*.test.{ts,tsx}",
  "src/providers/replay/harness.test.ts",
  "src/providers/replay/season-game.test.ts",
  "src/providers/replay/season-scoring.test.ts",
];

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.{ts,tsx}", "tests/**/*.test.{ts,tsx}"],
          exclude: dbTests,
        },
      },
      {
        // The first test in each worker boots and migrates the template
        // PGlite, which takes 5-7 s on a 2-core CI runner. Only database
        // tests get the longer limit, so slow unit tests still fail fast.
        extends: true,
        test: {
          name: "db",
          include: dbTests,
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
