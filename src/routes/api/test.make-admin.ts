import { createFileRoute } from "@tanstack/react-router";
import { eq } from "drizzle-orm";
import { users } from "@/db/schema";
import { withNoStore } from "@/server/no-store";

// Local builds only (`VITE_LOCAL_DB=1`): makes an account an admin by
// address, so Playwright can see a new admin's first steps. Roles are set by
// `pnpm staff set-role` (with an audit row) everywhere else. The flag is
// replaced at build time, so a normal build keeps the 404 and drops the rest.
async function makeAdmin(request: Request): Promise<Response> {
  if (import.meta.env.VITE_LOCAL_DB !== "1") {
    return withNoStore(new Response("Not found", { status: 404 }));
  }
  const body = (await request.json()) as { email?: string };
  if (typeof body.email !== "string") {
    return withNoStore(new Response("Bad request", { status: 400 }));
  }
  const { withDb } = await import("@/server/db");
  const email = body.email.toLowerCase();
  const changed = await withDb((db) =>
    db
      .update(users)
      .set({ role: "admin" })
      .where(eq(users.email, email))
      .returning({ id: users.id }),
  );
  // `test-hook-make-admin` marks this handler for the CI build check.
  return withNoStore(
    Response.json({ changed: changed.length, hook: "test-hook-make-admin" }),
  );
}

export const Route = createFileRoute("/api/test/make-admin")({
  server: { handlers: { POST: ({ request }) => makeAdmin(request) } },
});
