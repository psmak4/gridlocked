/**
 * The security headers (M9 Task 9). `SECURITY_HEADERS` goes on every response,
 * pages and assets alike, through Nitro's route rules (vite.config.ts). A
 * page also gets `contentSecurityPolicy(nonce)` from start.ts's request
 * middleware, with a nonce of its own that the router puts on each script it
 * writes (src/router.tsx), so no inline script runs without it.
 */

/** Turnstile's script, its challenge frame and its calls. */
const TURNSTILE = "https://challenges.cloudflare.com";

/** Where the Sentry browser SDK sends errors, by region. */
const SENTRY_INGEST = [
  "https://*.ingest.sentry.io",
  "https://*.ingest.us.sentry.io",
  "https://*.ingest.de.sentry.io",
];

/**
 * The page's policy: its own origin, the nonce, Turnstile and Sentry. Styles
 * allow inline, since components set `style` attributes; a style can't run
 * code.
 */
export function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' ${TURNSTILE}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    `connect-src 'self' ${TURNSTILE} ${SENTRY_INGEST.join(" ")}`,
    `frame-src ${TURNSTILE}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** A page's nonce: 128 random bits, base64. */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

/** On every response. */
export const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy":
    "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
} as const;
