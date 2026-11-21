/**
 * Who may be in the staff area (M8 Task 3). The layout route reads this to
 * send a locked session to the security page and anyone else away; every
 * staff server function checks again for itself (`staffFn`).
 */
import { requireStaff } from "@/identity/staff-roles";
import { IdentityError, type Viewer } from "@/identity/viewer";

export type StaffArea =
  | { state: "signed_out" }
  | { state: "not_staff" }
  /** Staff, without two-step sign-in or not unlocked this session. */
  | { state: "locked" }
  | {
      state: "open";
      username: string;
      role: "moderator" | "admin";
      /** Waiting items by menu screen (Tasks 10 and 11). */
      counts: Record<string, number>;
    };

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

/** Where the layout sends this visitor, or null to let them in. */
export function staffAreaRedirect(area: StaffArea): string | null {
  switch (area.state) {
    case "open":
      return null;
    case "locked":
      return "/settings/security";
    case "signed_out":
      return "/sign-in";
    case "not_staff":
      return "/";
  }
}
