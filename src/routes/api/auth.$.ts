import { createFileRoute } from "@tanstack/react-router";
import { withAuth } from "@/spike/auth";

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: ({ request }) => withAuth((auth) => auth.handler(request)),
      POST: ({ request }) => withAuth((auth) => auth.handler(request)),
    },
  },
});
