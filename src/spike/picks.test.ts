import { describe, expect, it } from "vitest";
import { pickInput } from "./picks";

const driverId = "01a18918-f870-72f4-b662-59eb50835577";

describe("pickInput", () => {
  it("accepts a 2026 round and a driver id", () => {
    expect(pickInput.parse({ round: 19, driverId })).toEqual({
      round: 19,
      driverId,
    });
  });

  it("rejects a round the 2026 calendar does not have", () => {
    expect(pickInput.safeParse({ round: 24, driverId }).success).toBe(false);
    expect(pickInput.safeParse({ round: 0, driverId }).success).toBe(false);
  });

  it("rejects a driver id that is not a uuid", () => {
    expect(pickInput.safeParse({ round: 19, driverId: "VER" }).success).toBe(
      false,
    );
  });
});
