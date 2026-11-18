import { describe, expect, it } from "vitest";
import { REVEAL_KEY, createBrowserReveal } from "./browser-reveal";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    storage: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    },
  };
}

describe("browserReveal", () => {
  it("is safe until set to all, and safe again after", () => {
    const { map, storage } = memoryStorage();
    const reveal = createBrowserReveal(() => storage);
    expect(reveal.get()).toBe("safe");
    reveal.set("all");
    expect(map.get(REVEAL_KEY)).toBe("all");
    expect(reveal.get()).toBe("all");
    reveal.set("safe");
    expect(map.has(REVEAL_KEY)).toBe(false);
    expect(reveal.get()).toBe("safe");
  });

  it("is safe when storage is missing or throws", () => {
    expect(createBrowserReveal(() => null).get()).toBe("safe");
    const throwing = createBrowserReveal(() => ({
      getItem: () => {
        throw new DOMException("denied", "SecurityError");
      },
      setItem: () => {
        throw new DOMException("full", "QuotaExceededError");
      },
      removeItem: () => {},
    }));
    expect(throwing.get()).toBe("safe");
    expect(() => throwing.set("all")).not.toThrow();
  });

  it("only the exact value counts", () => {
    const { map, storage } = memoryStorage();
    map.set(REVEAL_KEY, "ALL");
    expect(createBrowserReveal(() => storage).get()).toBe("safe");
  });
});
