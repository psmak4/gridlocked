import { describe, expect, it } from "vitest";
import {
  MoneyFormatError,
  formatDelta,
  formatMoney,
  parseMoney,
} from "./money";

describe("parseMoney", () => {
  it("parses whole and one-decimal amounts into $0.1M units", () => {
    expect(parseMoney("$23.4M")).toBe(234);
    expect(parseMoney("$100M")).toBe(1000);
    expect(parseMoney("$3.0M")).toBe(30);
    expect(parseMoney("$0M")).toBe(0);
  });

  it("throws MoneyFormatError for malformed text, never a silent 0", () => {
    for (const bad of ["23.4", "$23.45M", "$-1M", "", "$1.5B"]) {
      expect(() => parseMoney(bad)).toThrow(MoneyFormatError);
    }
  });

  it("names the offending input in the error message", () => {
    expect(() => parseMoney("23.4")).toThrow('Invalid money "23.4"');
  });
});

describe("formatMoney", () => {
  it("formats units as $X.YM with one decimal", () => {
    expect(formatMoney(234)).toBe("$23.4M");
    expect(formatMoney(1000)).toBe("$100.0M");
    expect(formatMoney(0)).toBe("$0.0M");
    expect(formatMoney(1005)).toBe("$100.5M");
  });

  it("drops a zero decimal when trimWhole is true", () => {
    expect(formatMoney(1000, { trimWhole: true })).toBe("$100M");
    expect(formatMoney(1005, { trimWhole: true })).toBe("$100.5M");
    expect(formatMoney(234, { trimWhole: true })).toBe("$23.4M");
  });

  it("throws RangeError for non-integer units", () => {
    expect(() => formatMoney(23.5)).toThrow(RangeError);
  });

  it("throws RangeError for negative units", () => {
    expect(() => formatMoney(-1)).toThrow(RangeError);
  });
});

describe("formatDelta", () => {
  it("prefixes a signed symbol and an absolute one-decimal value", () => {
    expect(formatDelta(2)).toBe("▲0.2");
    expect(formatDelta(-1)).toBe("▼0.1");
    expect(formatDelta(0)).toBe("■0.0");
    expect(formatDelta(-12)).toBe("▼1.2");
  });

  it("throws RangeError for non-integer units", () => {
    expect(() => formatDelta(1.5)).toThrow(RangeError);
  });
});
