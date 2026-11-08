import { createFileRoute } from "@tanstack/react-router";
import { eq } from "drizzle-orm";
import { users } from "@/db/schema";
import { withNoStore } from "@/server/no-store";

// Local builds only (`VITE_LOCAL_DB=1`): bans an account by address, so
// Playwright can see what a banned person sees. Staff bans go through the
// staff tools, which are not on the web. The flag is replaced at build time,
// so a normal build keeps the 404 and drops the rest.
async function ban(request: Request): Promise<Response> {
  if (import.meta.env.VITE_LOCAL_DB !== "1") {
    return withNoStore(new Response("Not found", { status: 404 }));
  }
  const body = (await request.json()) as { email?: string; reason?: string };
  if (typeof body.email !== "string") {
    return withNoStore(new Response("Bad request", { status: 400 }));
  }
  const { withDb } = await import("@/server/db");
  const email = body.email.toLowerCase();
  const changed = await withDb((db) =>
    db
      .update(users)
      .set({ banned: true, banReason: body.reason ?? null })
      .where(eq(users.email, email))
      .returning({ id: users.id }),
  );
  // `test-hook-ban-account` marks this handler for the CI build check.
  return withNoStore(
    Response.json({ banned: changed.length, hook: "test-hook-ban-account" }),
  );
}

export const Route = createFileRoute("/api/test/ban")({
  server: { handlers: { POST: ({ request }) => ban(request) } },
});
