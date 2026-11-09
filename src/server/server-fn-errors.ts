/**
 * Server functions never send an address or a link out in an error (the M5
 * constraint `auth-handler.ts` keeps for /api/auth). Start logs an unexpected
 * error whole and serializes it back to the browser, and a database error's
 * message carries the query's parameters: an email address, or a deletion
 * link. `start.ts` runs `scrubServerFnErrors` around every server function.
 */
import { createMiddleware } from "@tanstack/react-start";
import { isNotFound, isRedirect } from "@tanstack/react-router";
// Not `@/identity/viewer`: this module is in the client bundle too (the
// compiler drops only the `.server` body), and that one imports the schema.
import { IdentityError } from "@/identity/identity-error";

/** What the browser gets for anything that isn't a refusal or a redirect. */
export const SERVER_ERROR = "server_error";

/**
 * The error to send on: an `IdentityError` (it carries only its code), or
 * Start's redirect and notFound, as they are. Anything else is logged by its
 * name (and its cause's) and replaced with a value-free `Error`.
 */
/**
 * An error's class, never its message: its `name`, or its constructor's name
 * when `name` is the generic "Error" (DrizzleQueryError sets none). Both are
 * class names in code, so the line stays value-free (Ruling 59).
 */
function errorName(error: Error): string {
  if (error.name !== "Error") return error.name;
  const constructorName: unknown = error.constructor?.name;
  return typeof constructorName === "string" && constructorName !== ""
    ? constructorName
    : "Error";
}

export function scrubServerFnError(error: unknown): unknown {
  if (
    error instanceof IdentityError ||
    isRedirect(error) ||
    isNotFound(error)
  ) {
    return error;
  }
  const name = error instanceof Error ? errorName(error) : typeof error;
  const cause =
    error instanceof Error && error.cause instanceof Error
      ? ` (cause: ${errorName(error.cause)})`
      : "";
  console.error(`server function failed: ${name}${cause}`);
  return new Error(SERVER_ERROR);
}

/** Global function middleware (see `start.ts`), so no server function is missed. */
export const scrubServerFnErrors = createMiddleware({
  type: "function",
}).server(async ({ next }) => {
  try {
    return await next();
  } catch (error) {
    throw scrubServerFnError(error);
  }
});
