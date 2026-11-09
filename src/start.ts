import { createMiddleware, createStart } from "@tanstack/react-start";
import { noStoreOnError } from "@/server/no-store-errors";
import { scrubServerFnErrors } from "@/server/server-fn-errors";

// Runs on every request, after the route has built its response.
const noStoreErrors = createMiddleware().server(async ({ next }) => {
  const result = await next();
  noStoreOnError(result.response);
  return result;
});

export const startInstance = createStart(() => ({
  requestMiddleware: [noStoreErrors],
  // Runs around every server function, before its own middleware and its
  // validator: an unexpected error leaves with no address or link in it.
  functionMiddleware: [scrubServerFnErrors],
}));
