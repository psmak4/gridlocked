import { defineConfig } from "drizzle-kit";

// `generate` and `check` work offline, so no database credentials are needed.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema/index.ts",
  out: "./src/db/migrations",
});
