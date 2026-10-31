import { describe, expect, it } from "vitest";
import { noStoreOnError } from "./no-store-errors";

const cacheControl = (response: Response) =>
  response.headers.get("cache-control");

describe("noStoreOnError", () => {
  it("replaces a cacheable header on a 500 (the spike's finding)", () => {
    const response = new Response("boom", {
      status: 500,
      headers: {
        "cache-control": "public, s-maxage=60, stale-while-revalidate=300",
      },
    });
    expect(cacheControl(noStoreOnError(response))).toBe("private, no-store");
  });

  it("adds no-store to a 404 that has no header", () => {
    const response = new Response("missing", { status: 404 });
    expect(cacheControl(noStoreOnError(response))).toBe("private, no-store");
  });

  it("leaves a 200 and a 304 untouched", () => {
    const ok = new Response("ok", {
      status: 200,
      headers: { "cache-control": "public, s-maxage=60" },
    });
    const notModified = new Response(null, { status: 304 });
    expect(noStoreOnError(ok)).toBe(ok);
    expect(cacheControl(ok)).toBe("public, s-maxage=60");
    expect(noStoreOnError(notModified)).toBe(notModified);
    expect(cacheControl(notModified)).toBeNull();
  });
});
