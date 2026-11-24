import { createRouter } from "@tanstack/react-router";
import { getGlobalStartContext } from "@tanstack/react-start";
import { reportClientError, startClientReporting } from "./lib/report-client";
import { routeTree } from "./routeTree.gen";

/**
 * The page's CSP nonce, from start.ts's `pageCsp` (on the server, once the
 * request middleware has run). The browser never needs it: the scripts that
 * carry it are already in the page.
 */
function pageNonce(): string | undefined {
  try {
    return (getGlobalStartContext() as { nonce?: string } | undefined)?.nonce;
  } catch {
    return undefined;
  }
}

export function getRouter() {
  const router = createRouter({
    routeTree,
    scrollRestoration: true,
    ssr: { nonce: pageNonce() },
    // A route's boundary keeps a render error from Sentry's own handlers.
    defaultOnCatch: (error) => reportClientError(error),
  });
  // Errors to Sentry, scrubbed (M9 Task 10), when the build has a DSN.
  if (!router.isServer) void startClientReporting(router);
  return router;
}
