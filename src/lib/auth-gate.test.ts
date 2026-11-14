import { describe, expect, it } from "vitest";
import { gateRedirect, safeNext, signInFirst } from "./auth-gate";

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
      "/settings/delete/confirm",
      // Ruling 52: leaving, and taking your data, need nothing finished.
      "/settings/delete",
      "/settings/delete/",
      "/settings/data",
    ]) {
      expect(gateRedirect(path, incomplete)).toBeNull();
    }
  });

  it("does not let a look-alike path through", () => {
    expect(gateRedirect("/welcomed", incomplete)).toBe("/welcome");
    expect(gateRedirect("/legal", incomplete)).toBe("/welcome");
    expect(gateRedirect("/check-email-now", incomplete)).toBe("/welcome");
    expect(gateRedirect("/settings/deleted", incomplete)).toBe("/welcome");
    expect(gateRedirect("/settings/data/x", incomplete)).toBe("/welcome");
    expect(gateRedirect("/settings", incomplete)).toBe("/welcome");
    expect(gateRedirect("/settings/security", incomplete)).toBe("/welcome");
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

describe("the sign-in-first pages (M6)", () => {
  it("sends a logged-out visitor on Team or Leagues to sign in, with where they were going", () => {
    expect(signInFirst("/team", "", null)).toBe("/team");
    expect(signInFirst("/team/", "", null)).toBe("/team");
    expect(signInFirst("/team/1/points", "", null)).toBe("/team/1/points");
    expect(signInFirst("/leagues", "", null)).toBe("/leagues");
    expect(signInFirst("/leagues/abc", "?tab=x", null)).toBe(
      "/leagues/abc?tab=x",
    );
  });

  it("leaves the public pages and anyone signed in alone", () => {
    for (const path of ["/", "/weekend", "/prices", "/prices/how", "/teams"]) {
      expect(signInFirst(path, "", null)).toBeNull();
    }
    expect(signInFirst("/team", "", complete)).toBeNull();
    expect(signInFirst("/leagues", "", incomplete)).toBeNull();
  });

  it("takes back only a path on this site", () => {
    expect(safeNext("/team")).toBe("/team");
    expect(safeNext("/leagues/abc?tab=x")).toBe("/leagues/abc?tab=x");
    for (const bad of [
      undefined,
      "",
      "team",
      "//evil.example",
      "/\\evil.example",
      "https://evil.example/team",
      "/team\nx",
      "/sign-in",
      "/sign-in?next=/team",
      "/sign-up/email",
      `/${"a".repeat(600)}`,
      42,
    ]) {
      expect(safeNext(bad)).toBeUndefined();
    }
  });
});
