import { createFileRoute } from "@tanstack/react-router";
import { withNoStore } from "@/server/no-store";

// Local builds only (`VITE_LOCAL_DB=1`): serves a file from the in-memory
// export store, standing in for the bucket's signed link. The flag is
// replaced at build time, so a normal build keeps the 404 and drops the rest.
async function exportFile(request: Request): Promise<Response> {
  if (import.meta.env.VITE_LOCAL_DB !== "1") {
    return withNoStore(new Response("Not found", { status: 404 }));
  }
  const { localExportFiles } = await import("@/server/local-db");
  const key = new URL(request.url).searchParams.get("key") ?? "";
  const body = localExportFiles.get(key);
  if (body === undefined) {
    return withNoStore(new Response("Not found", { status: 404 }));
  }
  // `test-hook-export-file` marks this handler for the CI build check.
  return withNoStore(
    new Response(body, {
      headers: {
        "content-type": "application/json",
        "content-disposition":
          'attachment; filename="gridlocked-data-export.json"',
        "x-test-hook": "test-hook-export-file",
      },
    }),
  );
}

export const Route = createFileRoute("/api/test/export-file")({
  server: { handlers: { GET: ({ request }) => exportFile(request) } },
});
