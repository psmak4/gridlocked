import { describe, expect, it } from "vitest";
import { seededRandom } from "./random";

describe("seededRandom", () => {
  it("repeats a sequence from the same seed and differs between seeds", () => {
    const draw = (seed: number) => {
      const next = seededRandom(seed);
      return Array.from({ length: 5 }, next);
    };
    expect(draw(7)).toEqual(draw(7));
    expect(draw(7)).not.toEqual(draw(8));
    for (const n of draw(7)) {
      expect(n).toBeGreaterThanOrEqual(0);
      expect(n).toBeLessThan(1);
    }
  });
});
