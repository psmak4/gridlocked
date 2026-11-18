import { createFileRoute } from "@tanstack/react-router";
import { chatRefreshResponse } from "@/server/chat-refresh";
import { withRequestNow } from "@/server/session";

// Chat mode's refresh (HLD §11.2): public, cached per window, cookie-blind.
export const Route = createFileRoute("/api/chat/$threadId")({
  server: {
    handlers: {
      GET: ({ request, params }) =>
        chatRefreshResponse(request, params.threadId, (fn) =>
          withRequestNow(fn),
        ),
    },
  },
});
