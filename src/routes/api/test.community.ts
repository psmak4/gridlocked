import { createFileRoute } from "@tanstack/react-router";
import { eq } from "drizzle-orm";
import { profiles, users } from "@/db/schema";
import { withNoStore } from "@/server/no-store";

// Local builds only (`VITE_LOCAL_DB=1`): the forum's e2e setup. POST
// `{ email, trustLevel }` marks the account's address verified and sets its
// trust level, as days of reading would (DM 6.5), so Playwright can post as
// TL0 or TL1 from a new account. Trust is the daily job's everywhere else.
// The flag is replaced at build time, so a normal build keeps the 404 and
// drops the rest.
async function setTrust(request: Request): Promise<Response> {
  if (import.meta.env.VITE_LOCAL_DB !== "1") {
    return withNoStore(new Response("Not found", { status: 404 }));
  }
  const body = (await request.json().catch(() => ({}))) as {
    email?: unknown;
    trustLevel?: unknown;
  };
  const level = body.trustLevel;
  if (
    typeof body.email !== "string" ||
    typeof level !== "number" ||
    !Number.isInteger(level) ||
    level < 0 ||
    level > 3
  ) {
    return withNoStore(new Response("Bad request", { status: 400 }));
  }
  const { withDb } = await import("@/server/db");
  const email = body.email.toLowerCase();
  const changed = await withDb(async (db) => {
    const [user] = await db
      .update(users)
      .set({ emailVerified: true })
      .where(eq(users.email, email))
      .returning({ id: users.id });
    if (!user) return 0;
    await db
      .update(profiles)
      .set({ trustLevel: level })
      .where(eq(profiles.userId, user.id));
    return 1;
  });
  // `test-hook-community` marks this handler for the CI build check.
  return withNoStore(Response.json({ changed, hook: "test-hook-community" }));
}

export const Route = createFileRoute("/api/test/community")({
  server: { handlers: { POST: ({ request }) => setTrust(request) } },
});
