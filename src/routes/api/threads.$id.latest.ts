import { createFileRoute } from "@tanstack/react-router";
import { sql } from "drizzle-orm";
import { cacheControl } from "@/spike/cache";
import { withDb } from "@/spike/db";
import { raceResults } from "@/spike/results";

/**
 * Spike stand-in for a chat-mode thread refresh (HLD decision 19). Every
 * request that reaches this code logs one `spike_hits` row, so the probe can
 * count how many of a window's requests got past the CDN.
 */
export const Route = createFileRoute("/api/threads/$id/latest")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const w = new URL(request.url).searchParams.get("w") ?? "";
        const messages = await withDb(async (db) => {
          await db.execute(
            sql`insert into spike_hits (path) values (${`/api/threads/${params.id}/latest?w=${w}`})`,
          );
          return (await raceResults(db, 18)).slice(0, 10);
        });
        return Response.json(
          { thread: params.id, window: w, messages },
          { headers: { "Cache-Control": cacheControl("chat-window") } },
        );
      },
    },
  },
});
