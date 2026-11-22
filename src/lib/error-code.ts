/**
 * A value-free code for an error, when it carries one: Better Auth's
 * `APIError` keeps a constant such as `INVALID_TOKEN` in `body.code`. Only an
 * upper-case constant counts, so a code made from a message with a value in
 * it (an address has `@` and `.`) never reaches a log. No import of Better
 * Auth: the server-function scrub that uses this is in the client bundle too.
 */
const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;

export function errorCode(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const code = (error as { body?: { code?: unknown } }).body?.code;
  return typeof code === "string" && CODE.test(code) ? code : null;
}
