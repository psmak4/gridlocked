import { ProviderUnavailableError } from "@/jobs/ports";
import { ProviderHttpError } from "../http/client";

/**
 * Whether `error` means the provider could not answer: an HTTP error status
 * (a 5xx, or a 429 that outlasted the client's retries, or a body that is not
 * JSON), a timeout or abort, or a failed connection (`fetch` rejects with a
 * TypeError). Database and programming errors are not.
 */
function isOutage(error: unknown): boolean {
  return (
    error instanceof ProviderHttpError ||
    error instanceof TypeError ||
    (error instanceof DOMException &&
      (error.name === "TimeoutError" || error.name === "AbortError"))
  );
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
