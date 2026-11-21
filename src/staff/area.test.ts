import { describe, expect, it } from "vitest";
import type { Viewer } from "@/identity/viewer";
import { staffArea, staffAreaRedirect } from "./area";

const at = new Date("2026-11-21T09:00:00.000Z");
const admin = {
  userId: "u-1",
  role: "admin",
  banned: false,
  username: "preston",
  displayUsername: "preston",
  emailVerified: true,
  twoFactorEnabled: true,
  sessionId: "s-1",
  impersonatedBy: null,
  staffVerifiedAt: at,
  complete: true,
} as unknown as Viewer;

describe("the staff area's guard (M8 Task 3)", () => {
  it("an unlocked staff session is in, with who they are", () => {
    expect(staffArea(admin)).toEqual({
      state: "open",
      username: "preston",
      role: "admin",
      counts: {},
    });
    expect(staffArea({ ...admin, role: "moderator" })).toMatchObject({
      state: "open",
      role: "moderator",
    });
    expect(staffAreaRedirect(staffArea(admin))).toBeNull();
  });

  it("a locked staff session goes to the security page", () => {
    for (const v of [
      { ...admin, staffVerifiedAt: null },
      { ...admin, twoFactorEnabled: false, staffVerifiedAt: null },
    ]) {
      expect(staffArea(v)).toEqual({ state: "locked" });
      expect(staffAreaRedirect(staffArea(v))).toBe("/settings/security");
    }
  });

  it("anyone else goes home, and the signed out to sign in", () => {
    for (const v of [
      { ...admin, role: "user" },
      { ...admin, banned: true },
      { ...admin, impersonatedBy: "u-2" },
    ] as Viewer[]) {
      expect(staffArea(v)).toEqual({ state: "not_staff" });
      expect(staffAreaRedirect(staffArea(v))).toBe("/");
    }
    expect(staffArea(null)).toEqual({ state: "signed_out" });
    expect(staffAreaRedirect(staffArea(null))).toBe("/sign-in");
  });
});
