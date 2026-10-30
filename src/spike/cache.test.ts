import { describe, expect, it } from "vitest";
import { cacheControl, chatWindow } from "./cache";

describe("cacheControl", () => {
  it("lets the CDN share a logged-out page for a minute", () => {
    expect(cacheControl("public-page")).toBe(
      "public, s-maxage=60, stale-while-revalidate=300",
    );
  });

  it("lets the CDN share a chat window for three seconds", () => {
    expect(cacheControl("chat-window")).toBe("public, s-maxage=3");
  });

  it("never lets a shared cache store a signed-in response", () => {
    expect(cacheControl("private")).toBe("private, no-store");
  });
});

describe("chatWindow", () => {
  it("puts everyone in the same 3-second window on the same number", () => {
    expect(chatWindow(1_700_000_001_000)).toBe(chatWindow(1_700_000_002_999));
  });

  it("moves to the next number every 3 seconds", () => {
    expect(chatWindow(1_700_000_003_000)).toBe(
      chatWindow(1_700_000_000_000) + 1,
    );
  });

  it("is the epoch second divided by 3, rounded down", () => {
    expect(chatWindow(9_000)).toBe(3);
    expect(chatWindow(8_999)).toBe(2);
  });
});
