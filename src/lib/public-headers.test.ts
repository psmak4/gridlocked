import { describe, expect, it } from "vitest";
import { signInFirst } from "./auth-gate";
import {
  PUBLIC_CACHE,
  SESSION_COOKIE,
  SIGNED_IN_FLAG,
  publicCache,
  publicHeaders,
  signedInRoutes,
} from "./public-headers";

// The CDN caches public pages for logged-out readers (M9 Task 6). Vercel's
// CDN won't cache a response that varies on Cookie, so the split is made at
// the edge instead: a request that carries the session cookie gets a query
// flag added, which puts it under another cache key.

const NOW = new Date("2026-03-07T05:00:00.000Z");
const minutes = (n: number) => new Date(NOW.getTime() + n * 60_000);

describe("public headers (M9 Task 6)", () => {
  it("a request without a session cookie gets public, s-maxage=60, stale-while-revalidate=30 and no Vary: Cookie", () => {
    expect(PUBLIC_CACHE).toBe("public, s-maxage=60, stale-while-revalidate=30");
    expect(publicHeaders()).toEqual({ "Cache-Control": PUBLIC_CACHE });
  });

  it("within 30 minutes of a lock the stale window drops to 10 seconds", () => {
    const soon = "public, s-maxage=60, stale-while-revalidate=10";
    expect(publicCache(NOW, minutes(20))).toBe(soon);
    expect(publicCache(NOW, minutes(30))).toBe(soon);
    expect(publicCache(NOW, minutes(31))).toBe(PUBLIC_CACHE);
    expect(publicCache(NOW, minutes(-1))).toBe(PUBLIC_CACHE);
    expect(publicCache(NOW, null)).toBe(PUBLIC_CACHE);
    expect(publicHeaders(publicCache(NOW, minutes(5)))).toEqual({
      "Cache-Control": soon,
    });
  });

  it("a request with a session cookie is never answered from, or stored in, the shared copy", () => {
    // Every path, before Nitro's own routes, keyed on the session cookie.
    const [route, ...rest] = signedInRoutes();
    expect(rest).toEqual([]);
    expect(route).toEqual({
      src: "^/(.*)$",
      has: [{ type: "cookie", key: SESSION_COOKIE }],
      transforms: [
        {
          type: "request.query",
          op: "set",
          target: { key: SIGNED_IN_FLAG },
          args: "1",
        },
      ],
      continue: true,
    });
    expect(new RegExp(route!.src).test("/_serverFn/abc?payload=1")).toBe(true);
    expect(SESSION_COOKIE).toBe("__Secure-better-auth.session_token");
  });

  it("the flag never travels in a sign-in page's next", () => {
    expect(signInFirst("/leagues", `?${SIGNED_IN_FLAG}=1`, null)).toBe(
      "/leagues",
    );
    expect(signInFirst("/leagues/x", `?page=2&${SIGNED_IN_FLAG}=1`, null)).toBe(
      "/leagues/x?page=2",
    );
  });
});
