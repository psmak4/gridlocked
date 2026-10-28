import { describe, expect, it } from "vitest";
import { newId } from "./ids";

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("newId", () => {
  it("returns a lowercase UUIDv7 string", () => {
    expect(newId()).toMatch(UUID_V7);
  });

  it("returns unique IDs that sort in creation order as plain strings", () => {
    const ids = Array.from({ length: 1_000 }, () => newId());
    expect(new Set(ids).size).toBe(1_000);
    expect([...ids].sort()).toEqual(ids);
  });
});
