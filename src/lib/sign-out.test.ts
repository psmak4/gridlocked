import { describe, expect, it } from "vitest";
import { signOutHere } from "./sign-out";

describe("signing out", () => {
  it("signing out removes this browser's push subscription from the account", async () => {
    const calls: string[] = [];
    await signOutHere({
      forgetPush: async () => {
        calls.push("forget push");
      },
      signOut: async () => {
        calls.push("sign out");
      },
    });
    // While the session still counts, so the server can drop the row.
    expect(calls).toEqual(["forget push", "sign out"]);
  });

  it("a push that can't be forgotten doesn't stop the sign-out", async () => {
    const calls: string[] = [];
    await signOutHere({
      forgetPush: async () => {
        throw new Error("no service worker");
      },
      signOut: async () => {
        calls.push("sign out");
      },
    });
    expect(calls).toEqual(["sign out"]);
  });
});
