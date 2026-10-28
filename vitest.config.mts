import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests that create a test database run in the longer-timeout `db` project.
const dbTests = ["src/db/**/*.test.{ts,tsx}", "src/jobs/**/*.test.{ts,tsx}"];

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
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
