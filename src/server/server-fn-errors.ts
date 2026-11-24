/**
 * Server functions never send an address or a link out in an error (the M5
 * constraint `auth-handler.ts` keeps for /api/auth). Start logs an unexpected
 * error whole and serializes it back to the browser, and a database error's
 * message carries the query's parameters: an email address, or a deletion
 * link. `start.ts` runs `scrubServerFnErrors` around every server function.
 * An unexpected error is also reported to Sentry, scrubbed (M9 Task 10).
 */
import { createMiddleware } from "@tanstack/react-start";
import { isNotFound, isRedirect } from "@tanstack/react-router";
// Not `@/identity/viewer`: this module is in the client bundle too (the
// compiler drops only the `.server` body), and that one imports the schema.
import { IdentityError } from "@/identity/identity-error";
import { reportServerError, type ReportError } from "@/lib/server-reporter";
import { errorCode } from "@/lib/error-code";
import { errorName } from "@/lib/report-error";

/** What the browser gets for anything that isn't a refusal or a redirect. */
export const SERVER_ERROR = "server_error";

/** Whether an error is one a server function means to throw. */
const expected = (error: unknown) =>
  error instanceof IdentityError || isRedirect(error) || isNotFound(error);

/**
 * The error to send on: an `IdentityError` (it carries only its code), or
 * Start's redirect and notFound, as they are. Anything else is logged by its
 * name (and its cause's) and replaced with a value-free `Error`.
 */
export function scrubServerFnError(error: unknown): unknown {
  if (expected(error)) return error;
  const name = error instanceof Error ? errorName(error) : typeof error;
  const cause =
    error instanceof Error && error.cause instanceof Error
      ? ` (cause: ${errorName(error.cause)})`
      : "";
  // Better Auth's refusals carry a constant code; it says what failed.
  const code = errorCode(error);
  console.error(
    `server function failed: ${name}${code ? ` [${code}]` : ""}${cause}`,
  );
  return new Error(SERVER_ERROR);
}

/**
 * `scrubServerFnError`, with an unexpected error reported to Sentry under
 * its server function's file and name.
 */
export async function scrubAndReport(
  error: unknown,
  options: { route: string; report?: ReportError },
): Promise<unknown> {
  const scrubbed = scrubServerFnError(error);
  if (!expected(error)) {
    await (options.report ?? reportServerError)(error, options.route);
  }
  return scrubbed;
}

/** Global function middleware (see `start.ts`), so no server function is missed. */
export const scrubServerFnErrors = createMiddleware({
  type: "function",
}).server(async ({ next, serverFnMeta }) => {
  try {
    return await next();
  } catch (error) {
    // Start always passes it; a missing one mustn't turn into a TypeError here.
    const meta = serverFnMeta as typeof serverFnMeta | undefined;
    throw await scrubAndReport(error, {
      route: meta ? `${meta.filename}#${meta.name}` : "server-function",
    });
  }
});
