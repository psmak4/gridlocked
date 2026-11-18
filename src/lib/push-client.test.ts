import { describe, expect, it } from "vitest";
import { isIos, keyBytes } from "./push-client";

describe("the push client", () => {
  it("reads a base64url VAPID key into bytes", () => {
    expect([...keyBytes("AQID_-8")]).toEqual([1, 2, 3, 255, 239]);
  });

  it("knows an iPhone and an iPad that says it's a Mac", () => {
    const nav = (userAgent: string, maxTouchPoints = 0) =>
      ({ userAgent, maxTouchPoints }) as Navigator;
    expect(isIos(nav("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)"))).toBe(true);
    expect(isIos(nav("Mozilla/5.0 (Macintosh; Intel Mac OS X)", 5))).toBe(true);
    expect(isIos(nav("Mozilla/5.0 (Macintosh; Intel Mac OS X)"))).toBe(false);
    expect(isIos(nav("Mozilla/5.0 (Linux; Android 15)", 5))).toBe(false);
  });
});
