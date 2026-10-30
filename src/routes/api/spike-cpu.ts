import { createFileRoute } from "@tanstack/react-router";

/**
 * Spike (Task 5): the process's cumulative CPU time in microseconds, read
 * between serial requests to get each request's CPU. Off unless SPIKE_CPU=1.
 */
export const Route = createFileRoute("/api/spike-cpu")({
  server: {
    handlers: {
      GET: () => {
        if (process.env.SPIKE_CPU !== "1") {
          return new Response("not found", { status: 404 });
        }
        const { user, system } = process.cpuUsage();
        return Response.json({ us: user + system });
      },
    },
  },
});
