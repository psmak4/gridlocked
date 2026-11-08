import { describe, expect, it } from "vitest";
import { gateRedirect } from "./auth-gate";

const incomplete = { complete: false };
const complete = { complete: true };

describe("the signed-in gate", () => {
  it("leaves every page alone for a logged-out visitor", () => {
    for (const path of ["/", "/sign-up", "/welcome", "/legal/terms", "/x/y"]) {
      expect(gateRedirect(path, null)).toBeNull();
    }
  });

  it("sends an incomplete viewer to /welcome from anywhere else", () => {
    for (const path of [
      "/",
      "/sign-up",
      "/sign-in",
      "/components",
      "/welcome/favorites",
      "/welcome/spoilers",
      "/anything/at/all",
    ]) {
      expect(gateRedirect(path, incomplete)).toBe("/welcome");
    }
  });

  it("lets an incomplete viewer reach the pages that finish or leave", () => {
    for (const path of [
      "/welcome",
      "/welcome/",
      "/legal/terms",
      "/legal/community_rules",
      "/auth-error",
      "/check-email",
      "/reset-password",
      "/forgot-password",
    ]) {
      expect(gateRedirect(path, incomplete)).toBeNull();
    }
  });

  it("does not let a look-alike path through", () => {
    expect(gateRedirect("/welcomed", incomplete)).toBe("/welcome");
    expect(gateRedirect("/legal", incomplete)).toBe("/welcome");
    expect(gateRedirect("/check-email-now", incomplete)).toBe("/welcome");
  });

  it("sends a complete viewer away from the sign-in pages and Finish signing up", () => {
    for (const path of ["/sign-up", "/sign-up/email", "/sign-in", "/welcome"]) {
      expect(gateRedirect(path, complete)).toBe("/");
    }
  });

  it("leaves a complete viewer everything else, onboarding included", () => {
    for (const path of [
      "/",
      "/welcome/favorites",
      "/welcome/spoilers",
      "/legal/terms",
      "/check-email",
      "/reset-password",
      "/auth-error",
    ]) {
      expect(gateRedirect(path, complete)).toBeNull();
    }
  });
});
