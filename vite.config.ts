import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";

export default defineConfig({
  server: { port: 3000 },
  resolve: { tsconfigPaths: true },
  // Start must come before React. Nitro builds the Node server that
  // `pnpm start` runs (.output/server/index.mjs).
  plugins: [
    tailwindcss(),
    tanstackStart(),
    // Spike: PGlite (local runs only, ledger R1) loads its WASM and data
    // files from its own package folder, so it's traced, not bundled.
    // PGlite (and its data files) only in VITE_SPIKE_LOCAL builds; hosts never load it.
    nitro(
      process.env.VITE_SPIKE_LOCAL === "1"
        ? { traceDeps: ["@electric-sql/pglite*"] }
        : // Neon Functions serve no static files: SPIKE_INLINE_STATIC=1 bundles them.
          process.env.SPIKE_INLINE_STATIC === "1"
          ? { serveStatic: "inline" }
          : {},
    ),
    viteReact(),
  ],
});
