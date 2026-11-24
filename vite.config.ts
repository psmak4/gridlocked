import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { sentryTanstackStart } from "@sentry/tanstackstart-react/vite";
import { nitro } from "nitro/vite";
import { defineConfig, type PluginOption } from "vite";
import { signedInRoutes } from "./src/lib/public-headers";
import { SECURITY_HEADERS } from "./src/lib/security-headers";

/**
 * Source maps to Sentry (M9 Task 10), only in a deploy that has Sentry's
 * auth token: the plugin turns the maps on, uploads them under the build's
 * release, and deletes them, so none is served. Errors only: no middleware
 * or module instrumentation, and no telemetry of its own. Local and CI
 * builds have no token, and no plugin.
 */
function sentrySourceMaps(): PluginOption[] {
  const authToken = process.env.SENTRY_AUTH_TOKEN;
  if (!authToken) return [];
  return sentryTanstackStart({
    authToken,
    org: process.env.SENTRY_ORG,
    project: process.env.SENTRY_PROJECT,
    release: { name: process.env.VITE_SENTRY_RELEASE },
    autoInstrumentMiddleware: false,
    buildTimeInstrumentation: false,
    telemetry: false,
  });
}

export default defineConfig({
  server: { port: 3000 },
  resolve: { tsconfigPaths: true },
  // Start must come before React. Nitro builds the Node server that
  // `pnpm start` runs (.output/server/index.mjs).
  plugins: [
    tailwindcss(),
    tanstackStart(),
    // The plugin marks error responses from Nitro's own handlers, such as a
    // missing static file, `private, no-store` (HLD §11.4).
    nitro({
      plugins: ["./src/server/nitro-no-store.ts"],
      // On every response, pages and assets alike (M9 Task 9). A page's
      // Content-Security-Policy is set per request in src/start.ts.
      routeRules: { "/**": { headers: { ...SECURITY_HEADERS } } },
      // On Vercel (staging builds with NITRO_PRESET=vercel), a request with
      // the session cookie gets its own cache key before Nitro's routes run
      // (M9 Task 6). Nitro puts these ahead of the routes it generates.
      vercel: { config: { version: 3, routes: signedInRoutes() } },
      // A build for local runs (VITE_LOCAL_DB=1) carries PGlite, which loads
      // its WASM and data files from its own package folder: traced, not
      // bundled. Any other build has no PGlite at all.
      ...(process.env.VITE_LOCAL_DB === "1"
        ? { traceDeps: ["@electric-sql/pglite*"] }
        : {}),
    }),
    viteReact(),
    // Last, as Sentry's plugin asks.
    ...sentrySourceMaps(),
  ],
});
