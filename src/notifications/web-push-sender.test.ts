import { describe, expect, it } from "vitest";
import { pushSenderFromEnv } from "./web-push-sender";

describe("the web-push sender", () => {
  it("is null unless both VAPID keys are set", () => {
    expect(pushSenderFromEnv({})).toBeNull();
    expect(pushSenderFromEnv({ VAPID_PUBLIC_KEY: "a" })).toBeNull();
    expect(
      pushSenderFromEnv({ VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "b" }),
    ).toBeNull();
    expect(
      pushSenderFromEnv({ VAPID_PUBLIC_KEY: "a", VAPID_PRIVATE_KEY: "b" }),
    ).not.toBeNull();
  });
});
