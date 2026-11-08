import { createFileRoute } from "@tanstack/react-router";
import { withNoStore } from "@/server/no-store";

// Local builds only (`VITE_LOCAL_DB=1`): lists the emails the memory sender
// has taken, so Playwright can follow a link. The flag is replaced at build
// time, so a normal build keeps the 404 and drops the rest.
async function list(request: Request): Promise<Response> {
  if (import.meta.env.VITE_LOCAL_DB !== "1") {
    return withNoStore(new Response("Not found", { status: 404 }));
  }
  const { capturedEmails } = await import("@/server/local-db");
  const to = new URL(request.url).searchParams.get("to")?.toLowerCase();
  const emails = capturedEmails.filter(
    (email) => !to || email.to.toLowerCase() === to,
  );
  return withNoStore(Response.json({ emails }));
}

export const Route = createFileRoute("/api/test/emails")({
  server: { handlers: { GET: ({ request }) => list(request) } },
});
