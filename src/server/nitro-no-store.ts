import { definePlugin } from "nitro";
import { noStoreOnError } from "./no-store-errors";

// Nitro answers static files (/assets/*, the favicon) before Start's request
// middleware runs, and marked a missing asset `public, max-age=31536000,
// immutable`. This hook sees every response Nitro sends, those included.
export default definePlugin((nitroApp) => {
  nitroApp.hooks.hook("response", (response) => {
    noStoreOnError(response);
  });
});
