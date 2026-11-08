/**
 * Neon config as code (https://neon.com/docs/reference/neon-ts), applied by
 * `neon deploy` from the staging workflow (.github/workflows/deploy-staging.yml).
 *
 * - `scheduler` bucket: the due-times file (HLD §4.5). Declaring it makes Neon
 *   create the bucket and inject AWS_ENDPOINT_URL_S3, AWS_REGION and the
 *   access keys into the function, so the tick holds no secret of its own.
 * - `exports` bucket: data export files (DM 6.7), written by the
 *   `privacy_export` job and downloaded through 7-day presigned links. Same
 *   injected keys as `scheduler`.
 * - `tick` function: bundled from the entry file by the CLI (esbuild). Neon
 *   injects DATABASE_URL. The only `env` declared is the email sender's
 *   (RESEND_API_KEY and EMAIL_FROM), read from the deploy's own environment
 *   (the staging workflow passes them from the `staging` secrets). When
 *   either is unset or empty (GitHub passes a missing secret as ""), no `env`
 *   is declared and the function leaves queued emails queued. No value is
 *   ever written in this file.
 * - two schedule triggers (UTC), both on the `tick` function: a tick every
 *   minute, and the safety tick at minute 7 of every sixth hour (M1 result).
 *
 * Postgres exists on every branch and needs no entry. There is no `branch`
 * closure, so branch settings (compute size, protection) stay as they are.
 */
import { defineConfig } from "@neon/config/v1";

const resendApiKey = process.env.RESEND_API_KEY;
const emailFrom = process.env.EMAIL_FROM;
const emailEnv =
  resendApiKey && emailFrom
    ? { RESEND_API_KEY: resendApiKey, EMAIL_FROM: emailFrom }
    : undefined;

export default defineConfig({
  buckets: {
    scheduler: {},
    exports: {},
  },
  functions: {
    tick: {
      name: "Scheduler tick",
      source: "./src/jobs/functions/tick.ts",
      ...(emailEnv ? { env: emailEnv } : {}),
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
