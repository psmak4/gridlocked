import { createFileRoute } from "@tanstack/react-router";
import { withNoStore } from "@/server/no-store";
import { withAuth } from "@/server/session";

// Every answer from /api/auth/* is private, no-store, redirects and errors
// included (HLD §11.4). Better Auth reads and sets session cookies here.
async function handle(request: Request): Promise<Response> {
  try {
    return withNoStore(await withAuth((auth) => auth.handler(request)));
  } catch (error) {
    // Name only: a message could hold an address or a link.
    console.error(
      `auth route failed: ${error instanceof Error ? error.name : "unknown"}`,
    );
    return withNoStore(new Response("Server error", { status: 500 }));
  }
}

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: ({ request }) => handle(request),
      POST: ({ request }) => handle(request),
    },
  },
});
