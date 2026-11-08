import { describe, expect, it } from "vitest";
import { formatCountdown } from "./format-countdown";

describe("formatCountdown", () => {
  it("shows minutes and two-digit seconds", () => {
    expect(formatCountdown(42)).toBe("0:42");
    expect(formatCountdown(40)).toBe("0:40");
    expect(formatCountdown(5)).toBe("0:05");
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(65)).toBe("1:05");
  });

  it("never goes negative", () => {
    expect(formatCountdown(-3)).toBe("0:00");
  });
});
