import { describe, expect, it } from "vitest";
import { kebab, normalizeEventName, uniqueSlug } from "./slugs";

describe("kebab", () => {
  it("joins words with hyphens", () => {
    expect(kebab("max_verstappen")).toBe("max-verstappen");
    expect(kebab("Bahrain Grand Prix in Malaysia")).toBe(
      "bahrain-grand-prix-in-malaysia",
    );
  });
  it("drops accents and edge punctuation", () => {
    expect(kebab("  São Paulo Grand Prix! ")).toBe("sao-paulo-grand-prix");
  });
});

describe("normalizeEventName", () => {
  it("lowercases and strips grand prix, gp and punctuation", () => {
    expect(normalizeEventName("Chinese Grand Prix")).toBe("chinese");
    expect(normalizeEventName("Chinese GP")).toBe("chinese");
    expect(normalizeEventName("São Paulo Grand Prix")).toBe("sao paulo");
    expect(normalizeEventName("Emilia-Romagna  Grand Prix")).toBe(
      "emilia romagna",
    );
    expect(normalizeEventName("Bahrain Grand Prix in Malaysia")).toBe(
      "bahrain in malaysia",
    );
  });
  it("keeps GP-like letters inside other words", () => {
    expect(normalizeEventName("Gpstown Grand Prix")).toBe("gpstown");
  });
});

describe("uniqueSlug", () => {
  it("adds a numeric suffix until the slug is free", async () => {
    const taken = new Set(["a", "a-2"]);
    expect(await uniqueSlug("a", async (s) => taken.has(s))).toBe("a-3");
    expect(await uniqueSlug("b", async (s) => taken.has(s))).toBe("b");
  });
  it("falls back for an empty base", async () => {
    expect(await uniqueSlug("", async () => false)).toBe("item");
  });
});
