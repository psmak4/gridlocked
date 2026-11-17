/**
 * Cloudflare Turnstile for our own forms (a logged-out report, DM 5.8). Better
 * Auth's captcha plugin guards the auth forms; this checks a token the same
 * way for everything else. Any failure, including Cloudflare being out of
 * reach, is a no.
 */
import { LOCAL_TURNSTILE_TOKEN } from "@/components/turnstile";

export const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

export type TokenVerifier = (token: string) => Promise<boolean>;

export function createTurnstileVerifier({
  secret,
  local,
  fetch,
}: {
  secret: string | null;
  /** A local build: with no secret, the stand-in's token passes. */
  local: boolean;
  fetch: typeof globalThis.fetch;
}): TokenVerifier {
  return async (token) => {
    if (!token) return false;
    if (!secret) return local && token === LOCAL_TURNSTILE_TOKEN;
    try {
      const response = await fetch(SITEVERIFY_URL, {
        method: "POST",
        body: new URLSearchParams({ secret, response: token }),
      });
      if (!response.ok) return false;
      const body = (await response.json()) as { success?: unknown };
      return body.success === true;
    } catch {
      return false;
    }
  };
}
