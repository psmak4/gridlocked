import {
  createCsrfMiddleware,
  createMiddleware,
  createStart,
} from "@tanstack/react-start";
import { noStoreOnError } from "@/server/no-store-errors";
import { scrubServerFnErrors } from "@/server/server-fn-errors";

// Runs on every request, after the route has built its response.
const noStoreErrors = createMiddleware().server(async ({ next }) => {
  const result = await next();
  noStoreOnError(result.response);
  return result;
});

/**
 * Start's own CSRF check for server-function requests (Ruling 59): a request
 * whose Sec-Fetch-Site, Origin or Referer says it came from another site is
 * refused with a 403. Start adds this by default only when there is no start
 * instance, so it is listed here. Page requests (and the server functions
 * their SSR calls in-process) are left alone. After `noStoreErrors`, so the
 * 403 is marked no-store too.
 */
export const serverFnCsrf = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
});

export const startInstance = createStart(() => ({
  requestMiddleware: [noStoreErrors, serverFnCsrf],
  // Runs around every server function, before its own middleware and its
  // validator: an unexpected error leaves with no address or link in it.
  functionMiddleware: [scrubServerFnErrors],
}));
