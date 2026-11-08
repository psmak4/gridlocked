import { withNoStore } from "./no-store";
import { withAuth, type SessionDeps } from "./session";

/**
 * A banned person opening a sign-in link would be handed Better Auth's JSON
 * (the endpoint has no error page of its own for it). Send them to the plain
 * message instead; the ban's reason stays out of the address.
 */
async function bannedLinkRedirect(
  request: Request,
  response: Response,
): Promise<Response> {
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    response.status !== 403 ||
    !url.pathname.endsWith("/magic-link/verify")
  ) {
    return response;
  }
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  if ((body as { code?: unknown } | null)?.code !== "BANNED_USER") {
    return response;
  }
  return Response.redirect(new URL("/auth-error?error=BANNED_USER", url), 302);
}

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
    const response = await withAuth((auth) => auth.handler(request), deps);
    return withNoStore(await bannedLinkRedirect(request, response));
  } catch (error) {
    // Name only: a message could hold an address or a link.
    console.error(
      `auth route failed: ${error instanceof Error ? error.name : "unknown"}`,
    );
    return withNoStore(new Response("Server error", { status: 500 }));
  }
}
