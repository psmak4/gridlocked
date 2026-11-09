import { createFileRoute } from "@tanstack/react-router";
import { and, eq, inArray, sql } from "drizzle-orm";
import { jobs } from "@/db/schema";
import { withNoStore } from "@/server/no-store";

// Local builds only (`VITE_LOCAL_DB=1`): runs every queued `privacy_export`
// job now, with the in-memory export store and the memory sender, since no
// scheduler runs locally. Other kinds are left alone. The flag is replaced
// at build time, so a normal build keeps the 404 and drops the rest.
async function runExports(): Promise<Response> {
  if (import.meta.env.VITE_LOCAL_DB !== "1") {
    return withNoStore(new Response("Not found", { status: 404 }));
  }
  const { withRequestNow } = await import("@/server/session");
  const { localExportStore, memorySender } = await import("@/server/local-db");
  const { createPrivacyExportHandler } = await import("@/identity/export");
  const { complete } = await import("@/jobs/queue");
  const { fixedClock } = await import("@/lib/clock");
  const handler = createPrivacyExportHandler({
    store: localExportStore,
    sender: memorySender,
    log: () => {},
  });
  const ran = await withRequestNow(async (db, now) => {
    const claimed = await db
      .update(jobs)
      .set({
        status: "running",
        attempts: sql`${jobs.attempts} + 1`,
        startedAt: now,
        lockedUntil: new Date(now.getTime() + 60_000),
      })
      .where(
        and(
          eq(jobs.kind, "privacy_export"),
          inArray(jobs.status, ["pending", "failed"]),
        ),
      )
      .returning();
    for (const job of claimed) {
      await handler(job, { db, clock: fixedClock(now) });
      await complete(db, job, now);
    }
    return claimed.length;
  });
  // `test-hook-run-exports` marks this handler for the CI build check.
  return withNoStore(Response.json({ ran, hook: "test-hook-run-exports" }));
}

export const Route = createFileRoute("/api/test/run-exports")({
  server: { handlers: { POST: () => runExports() } },
});
