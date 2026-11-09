import { createFileRoute } from "@tanstack/react-router";
import { eq } from "drizzle-orm";
import { legalAcceptances, users } from "@/db/schema";
import { withNoStore } from "@/server/no-store";

// Local builds only (`VITE_LOCAL_DB=1`): forgets which documents an account
// accepted, as a new version of the terms needing acceptance again would, so
// Playwright can see a gated account leave or take its data (ruling 52). The
// flag is replaced at build time, so a normal build keeps the 404 and drops
// the rest.
async function clearAcceptances(request: Request): Promise<Response> {
  if (import.meta.env.VITE_LOCAL_DB !== "1") {
    return withNoStore(new Response("Not found", { status: 404 }));
  }
  const body = (await request.json()) as { email?: string };
  if (typeof body.email !== "string") {
    return withNoStore(new Response("Bad request", { status: 400 }));
  }
  const { withDb } = await import("@/server/db");
  const email = body.email.toLowerCase();
  const cleared = await withDb(async (db) => {
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, email));
    if (!user) return 0;
    const rows = await db
      .delete(legalAcceptances)
      .where(eq(legalAcceptances.userId, user.id))
      .returning({ documentId: legalAcceptances.documentId });
    return rows.length;
  });
  // `test-hook-clear-acceptances` marks this handler for the CI build check.
  return withNoStore(
    Response.json({ cleared, hook: "test-hook-clear-acceptances" }),
  );
}

export const Route = createFileRoute("/api/test/clear-acceptances")({
  server: { handlers: { POST: ({ request }) => clearAcceptances(request) } },
});
