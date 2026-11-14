import { createFileRoute } from "@tanstack/react-router";
import { withNoStore } from "@/server/no-store";

// Local builds only (`VITE_LOCAL_DB=1`): moves the fantasy e2e server's
// simulated clock. POST `{ to }` (a whole minute, not before the clock) runs
// the scheduler tick there in `jump` steps, so every job due on the way (lock,
// polls, scoring, finalize, prices) runs on the recorded 2026 results.
// Returns `{ now, jobsRun }`. Seed first (`/api/test/game`). The flag is
// replaced at build time, so a normal build keeps the 404 and drops the rest.
// `test-hook-clock` marks this handler for the CI build check.
const text = (body: string, status: number) =>
  withNoStore(new Response(body, { status }));

async function moveClock(request: Request): Promise<Response> {
  if (import.meta.env.VITE_LOCAL_DB !== "1") return text("Not found", 404);
  const body = (await request.json().catch(() => ({}))) as { to?: unknown };
  const to = typeof body.to === "string" ? new Date(body.to) : null;
  if (!to || Number.isNaN(to.getTime()) || to.getTime() % 60_000 !== 0) {
    return text("`to` must be an ISO instant on a whole minute", 400);
  }
  const { moveTestClock, HarnessError } = await import("@/server/test-game");
  try {
    const moved = await moveTestClock(to);
    return withNoStore(Response.json({ ...moved, hook: "test-hook-clock" }));
  } catch (error) {
    if (error instanceof HarnessError) return text(error.message, error.status);
    throw error;
  }
}

export const Route = createFileRoute("/api/test/clock")({
  server: { handlers: { POST: ({ request }) => moveClock(request) } },
});
