/**
 * Neon config as code (https://neon.com/docs/reference/neon-ts), applied by
 * `neon deploy` from the staging workflow (.github/workflows/deploy-staging.yml).
 *
 * - `scheduler` bucket: the due-times file (HLD §4.5). Declaring it makes Neon
 *   create the bucket and inject AWS_ENDPOINT_URL_S3, AWS_REGION and the
 *   access keys into the function, so the tick holds no secret of its own.
 * - `tick` function: bundled from the entry file by the CLI (esbuild). Neon
 *   injects DATABASE_URL, so no `env` is declared and no secret passes
 *   through this file.
 * - two schedule triggers (UTC), both on the `tick` function: a tick every
 *   minute, and the safety tick at minute 7 of every sixth hour (M1 result).
 *
 * Postgres exists on every branch and needs no entry. There is no `branch`
 * closure, so branch settings (compute size, protection) stay as they are.
 */
import { defineConfig } from "@neon/config/v1";

export default defineConfig({
  buckets: {
    scheduler: {},
  },
  functions: {
    tick: {
      name: "Scheduler tick",
      source: "./src/jobs/functions/tick.ts",
    },
  },
  triggers: {
    "tick-every-minute": {
      type: "schedule",
      function: "tick",
      cron: "* * * * *",
      functionPath: "/",
    },
    "safety-every-6h": {
      type: "schedule",
      function: "tick",
      cron: "7 */6 * * *",
      functionPath: "/safety",
    },
  },
});
