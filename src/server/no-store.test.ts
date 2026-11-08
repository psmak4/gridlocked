import { describe, expect, it } from "vitest";
import { withNoStore } from "./no-store";

describe("withNoStore", () => {
  it("a 200, a 302 with immutable headers, and an error all come back private, no-store", () => {
    const ok = withNoStore(new Response("hi", { status: 200 }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("private, no-store");

    // Response.redirect() returns a response whose headers are immutable.
    const redirect = Response.redirect("https://example.test/next", 302);
    expect(() => redirect.headers.set("x", "y")).toThrow();
    const moved = withNoStore(redirect);
    expect(moved.status).toBe(302);
    expect(moved.headers.get("location")).toBe("https://example.test/next");
    expect(moved.headers.get("cache-control")).toBe("private, no-store");

    const failed = withNoStore(
      new Response("no", {
        status: 500,
        headers: { "Cache-Control": "public, s-maxage=60" },
      }),
    );
    expect(failed.status).toBe(500);
    expect(failed.headers.get("cache-control")).toBe("private, no-store");
  });

  it("keeps the body and the other headers when it has to copy", async () => {
    const immutable = Response.redirect("https://example.test/x", 301);
    const out = withNoStore(immutable);
    expect(out).not.toBe(immutable);
    expect(out.status).toBe(301);
    expect(out.headers.get("location")).toBe("https://example.test/x");
    expect(await out.text()).toBe("");

    const withBody = new Response("hello", { headers: { "x-keep": "1" } });
    Object.defineProperty(withBody, "headers", {
      value: Response.redirect("https://example.test/y").headers,
    });
    expect(await withNoStore(withBody).text()).toBe("hello");
  });
});
