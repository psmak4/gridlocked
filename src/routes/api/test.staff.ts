import { createFileRoute } from "@tanstack/react-router";
import { withNoStore } from "@/server/no-store";

// Local builds only (`VITE_LOCAL_DB=1`): runs one `pnpm staff` command on the
// local database, so the exit spec can take a moderator's action the way the
// staff workflow does (`scripts/staff.ts`, until M8's screens). POST
// `{ command, env }`: the command's name and its STAFF_* inputs, parsed by the
// same `parseStaffEnv`. The flag is replaced at build time, so a normal build
// keeps the 404 and drops the rest.
async function runStaff(request: Request): Promise<Response> {
  if (import.meta.env.VITE_LOCAL_DB !== "1") {
    return withNoStore(new Response("Not found", { status: 404 }));
  }
  const body = (await request.json().catch(() => ({}))) as {
    command?: unknown;
    env?: unknown;
  };
  if (
    typeof body.command !== "string" ||
    typeof body.env !== "object" ||
    body.env === null
  ) {
    return withNoStore(new Response("Bad request", { status: 400 }));
  }
  const { parseStaffEnv, runStaffCommand } = await import("@/staff/cli");
  const { withRequestNow } = await import("@/server/session");
  let cmd;
  try {
    cmd = parseStaffEnv(body.command, body.env as Record<string, string>);
  } catch (error) {
    return withNoStore(
      new Response(error instanceof Error ? error.message : "Bad request", {
        status: 400,
      }),
    );
  }
  const report = await withRequestNow((db, now) =>
    runStaffCommand(db, now, cmd),
  );
  // `test-hook-staff` marks this handler for the CI build check.
  return withNoStore(Response.json({ report, hook: "test-hook-staff" }));
}

export const Route = createFileRoute("/api/test/staff")({
  server: { handlers: { POST: ({ request }) => runStaff(request) } },
});
