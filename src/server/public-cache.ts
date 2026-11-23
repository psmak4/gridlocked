import { setResponseHeader } from "@tanstack/react-start/server";
import { PUBLIC_CACHE } from "@/lib/public-headers";

/**
 * A public answer's headers: private for a signed-in viewer, else cacheable
 * (`cacheControl`, from `publicCache` near a lock). The edge puts a request
 * with the session cookie under its own cache key (`signedInRoutes`), so the
 * CDN never answers a signed-in request from a logged-out visitor's copy,
 * though the server-function URL is the same for both. Call it from a server
 * function's handler only.
 */
export function cacheFor(viewer: unknown, cacheControl: string = PUBLIC_CACHE) {
  setResponseHeader(
    "Cache-Control",
    viewer ? "private, no-store" : cacheControl,
  );
}
