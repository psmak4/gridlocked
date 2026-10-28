import { ProviderUnavailableError } from "@/jobs/ports";
import { isNetworkFailure, ProviderHttpError } from "../http/client";

/**
 * Whether `error` means the provider could not answer, so the caller should
 * carry on and ask again later:
 * - a 5xx, or a 429 that outlasted the client's retries;
 * - a body that is not JSON (the client reports it with the 2xx status);
 * - an error thrown by the `fetch` call itself: a refused or dropped
 *   connection, a timeout, an abort.
 * Everything else is a bug and must fail the job so the runner surfaces it:
 * any other status (a 400, 403 or 404 means we asked wrongly), a TypeError
 * from building the URL, and every database error.
 */
function isOutage(error: unknown): boolean {
  if (isNetworkFailure(error)) return true;
  if (!(error instanceof ProviderHttpError)) return false;
  const { status } = error;
  return status >= 500 || status === 429 || (status >= 200 && status < 300);
}

/** Runs a provider call, turning an outage into `ProviderUnavailableError`. */
export async function asOutage<T>(
  what: string,
  call: () => Promise<T>,
): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (!isOutage(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new ProviderUnavailableError(`${what}: ${message}`, {
      cause: error,
    });
  }
}
