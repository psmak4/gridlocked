import { describe, expect, it } from "vitest";

// M7 split `auth.ts` into this directory. Every caller still imports
// `@/identity/auth`, so the index must export exactly what the file did.
describe("@/identity/auth", () => {
  it("exports the same names as the single file did", async () => {
    const auth = await import("./index");
    expect(Object.keys(auth).sort()).toEqual([
      "DISABLED_AUTH_PATHS",
      "IMPERSONATION_READ_ONLY",
      "IMPERSONATION_SECONDS",
      "MAGIC_LINK_SIGN_IN",
      "STAFF_SESSION_UNVERIFIED",
      "TOTP_PERIOD_SECONDS",
      "auditImpersonationStop",
      "createAuth",
      "ensureProfile",
      "logAuthEvent",
      "readTwoFactor",
    ]);
  });
});
