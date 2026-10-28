import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
    // Each PGlite test database boots a WASM Postgres; on a 2-core CI runner
    // two of them can take longer than Vitest's 5 s default.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
