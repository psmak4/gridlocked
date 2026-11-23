import { describe, expect, it } from "vitest";
import {
  contentSecurityPolicy,
  newNonce,
  SECURITY_HEADERS,
} from "./security-headers";

/** The policy's directives, by name. */
function directives(csp: string): Map<string, string[]> {
  return new Map(
    csp.split(";").map((part) => {
      const [name, ...values] = part.trim().split(/\s+/);
      return [name!, values];
    }),
  );
}

describe("the Content-Security-Policy (M9 Task 9)", () => {
  const csp = directives(contentSecurityPolicy("abc123"));

  it("allows scripts from the app's own origin, the page's nonce and Turnstile only", () => {
    expect(csp.get("script-src")).toEqual([
      "'self'",
      "'nonce-abc123'",
      "https://challenges.cloudflare.com",
    ]);
  });

  it("connects only to the app, Turnstile and Sentry's ingest", () => {
    expect(csp.get("connect-src")).toEqual([
      "'self'",
      "https://challenges.cloudflare.com",
      "https://*.ingest.sentry.io",
      "https://*.ingest.us.sentry.io",
      "https://*.ingest.de.sentry.io",
    ]);
    expect(csp.get("frame-src")).toEqual(["https://challenges.cloudflare.com"]);
  });

  it("refuses framing, plugins, other bases and other form targets", () => {
    expect(csp.get("default-src")).toEqual(["'self'"]);
    expect(csp.get("frame-ancestors")).toEqual(["'none'"]);
    expect(csp.get("object-src")).toEqual(["'none'"]);
    expect(csp.get("base-uri")).toEqual(["'self'"]);
    expect(csp.get("form-action")).toEqual(["'self'"]);
  });

  it("never allows inline scripts or eval", () => {
    const all = [...csp.values()].flat();
    expect(all).not.toContain("'unsafe-eval'");
    expect(csp.get("script-src")).not.toContain("'unsafe-inline'");
  });
});

describe("newNonce", () => {
  it("is 128 random bits, base64, different each time", () => {
    const a = newNonce();
    const b = newNonce();
    expect(a).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(a).not.toBe(b);
  });
});

describe("the headers every response carries", () => {
  it("are nosniff, a strict referrer, no framing, no powerful features and HSTS", () => {
    expect(SECURITY_HEADERS).toEqual({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Frame-Options": "DENY",
      "Permissions-Policy":
        "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
      "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
    });
  });
});
