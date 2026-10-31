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
    // The plugin marks error responses from Nitro's own handlers, such as a
    // missing static file, `private, no-store` (HLD §11.4).
    nitro({ plugins: ["./src/server/nitro-no-store.ts"] }),
    viteReact(),
  ],
});
