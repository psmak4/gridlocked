import { setResponseHeader } from "@tanstack/react-start/server";
import { PUBLIC_CACHE, PUBLIC_VARY } from "@/lib/public-headers";

/**
 * A public answer's headers: private for a signed-in viewer, else cacheable
 * and keyed on the cookie, so the CDN never answers a signed-in request from
 * a logged-out visitor's copy (the server-function URL is the same for both).
 * Call it from a server function's handler only.
 */
export function cacheFor(viewer: unknown) {
  if (viewer) {
    setResponseHeader("Cache-Control", "private, no-store");
    return;
  }
  setResponseHeader("Cache-Control", PUBLIC_CACHE);
  setResponseHeader("Vary", PUBLIC_VARY);
}
