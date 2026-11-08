import { withNoStore } from "./no-store";
import { withAuth, type SessionDeps } from "./session";

/**
 * Answers one /api/auth/* request. Every answer is private, no-store,
 * redirects (the magic link, the Discord callback) and errors included
 * (HLD §11.4). Better Auth reads and sets session cookies here.
 */
export async function handleAuth(
  request: Request,
  deps?: SessionDeps,
): Promise<Response> {
  try {
    return withNoStore(await withAuth((auth) => auth.handler(request), deps));
  } catch (error) {
    // Name only: a message could hold an address or a link.
    console.error(
      `auth route failed: ${error instanceof Error ? error.name : "unknown"}`,
    );
    return withNoStore(new Response("Server error", { status: 500 }));
  }
}
