/**
 * Who may be in the staff area (M8 Task 3). The layout route reads this to
 * send a locked session to the security page and anyone else away; every
 * staff server function checks again for itself (`staffFn`).
 */
import { requireStaff } from "@/identity/staff-roles";
import { IdentityError, type Viewer } from "@/identity/viewer";
import type { StaffArea } from "./area-redirect";

export { type StaffArea, staffAreaRedirect } from "./area-redirect";

export function staffArea(viewer: Viewer | null): StaffArea {
  try {
    const v = requireStaff(viewer, "moderator");
    return {
      state: "open",
      username: v.displayUsername ?? v.username ?? "staff",
      role: v.role === "admin" ? "admin" : "moderator",
      counts: {},
    };
  } catch (error) {
    if (!(error instanceof IdentityError)) throw error;
    switch (error.code) {
      case "unauthenticated":
        return { state: "signed_out" };
      case "staff_two_factor_required":
      case "staff_session_unverified":
        return { state: "locked" };
      default:
        return { state: "not_staff" };
    }
  }
}
