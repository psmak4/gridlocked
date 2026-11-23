import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";
import { signedInRoutes } from "./src/lib/public-headers";

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
  ],
});
