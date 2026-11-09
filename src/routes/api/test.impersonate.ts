import { createFileRoute } from "@tanstack/react-router";
import { eq } from "drizzle-orm";
import { users } from "@/db/schema";
import { withNoStore } from "@/server/no-store";

// Local builds only (`VITE_LOCAL_DB=1`): starts an impersonation from the
// signed-in admin's session (its cookie), as M8's staff screen will, through
// `startImpersonation` and all its checks. The flag is replaced at build
// time, so a normal build keeps the 404 and drops the rest.
async function impersonate(request: Request): Promise<Response> {
  if (import.meta.env.VITE_LOCAL_DB !== "1") {
    return withNoStore(new Response("Not found", { status: 404 }));
  }
  const body = (await request.json()) as { username?: string; reason?: string };
  if (typeof body.username !== "string") {
    return withNoStore(new Response("Bad request", { status: 400 }));
  }
  const { getViewer, withAuth } = await import("@/server/session");
  const { startImpersonation } = await import("@/identity/impersonation");
  const viewer = await getViewer(request);
  const username = body.username.toLowerCase();
  const { headers } = await withAuth(async (auth, db, now) => {
    const [target] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.username, username));
    return startImpersonation(auth, db, now, {
      viewer,
      targetUserId: target?.id ?? "00000000-0000-0000-0000-000000000001",
      reason: body.reason ?? "",
      headers: request.headers,
    });
  });
  // `test-hook-impersonate` marks this handler for the CI build check.
  const response = Response.json({ hook: "test-hook-impersonate" });
  for (const cookie of headers.getSetCookie()) {
    response.headers.append("set-cookie", cookie);
  }
  return withNoStore(response);
}

export const Route = createFileRoute("/api/test/impersonate")({
  server: { handlers: { POST: ({ request }) => impersonate(request) } },
});
