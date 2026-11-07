import { describe, expect, it } from "vitest";
import { SYSTEM_USER_ID } from "./system";

describe("SYSTEM_USER_ID", () => {
  it("is the all-zero uuid that existing rows already hold", () => {
    expect(SYSTEM_USER_ID).toBe("00000000-0000-0000-0000-000000000000");
  });
});
