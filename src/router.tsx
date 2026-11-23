import { createRouter } from "@tanstack/react-router";
import { getGlobalStartContext } from "@tanstack/react-start";
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
  return createRouter({
    routeTree,
    scrollRestoration: true,
    ssr: { nonce: pageNonce() },
  });
}
