import { createMiddleware, createStart } from "@tanstack/react-start";
import { noStoreOnError } from "@/server/no-store-errors";

// Runs on every request, after the route has built its response.
const noStoreErrors = createMiddleware().server(async ({ next }) => {
  const result = await next();
  noStoreOnError(result.response);
  return result;
});

export const startInstance = createStart(() => ({
  requestMiddleware: [noStoreErrors],
}));
