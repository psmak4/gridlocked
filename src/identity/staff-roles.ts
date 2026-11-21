/**
 * The staff roles, their order and the staff check (DM 6.4), apart from
 * `roles.ts` and `staff-access.ts`: the auth config reads `roles.ts`, and
 * `staff-access.ts` reads the auth config, so the check lives where both can
 * import it without a cycle.
 */
import type { UserRole } from "@/db/schema";
import { IdentityError, requireViewer, type Viewer } from "./viewer";

/** The roles staff tools check for, lowest first. */
export const STAFF_ROLES = ["moderator", "admin"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

/** True if `role` is at least `needed`. `system` and `user` are never staff. */
export function hasStaffRole(role: UserRole, needed: StaffRole): boolean {
  const rank = (r: UserRole) => STAFF_ROLES.indexOf(r as StaffRole);
  return rank(role) >= 0 && rank(role) >= rank(needed);
}

/** Staff with at least `role`, an unlocked session, and not impersonated. */
export function requireStaff(viewer: Viewer | null, role: StaffRole): Viewer {
  const v = requireViewer(viewer);
  if (v.impersonatedBy !== null) throw new IdentityError("read_only");
  if (v.banned || !hasStaffRole(v.role, role)) {
    throw new IdentityError("forbidden");
  }
  if (!v.twoFactorEnabled) throw new IdentityError("staff_two_factor_required");
  if (v.staffVerifiedAt === null) {
    throw new IdentityError("staff_session_unverified");
  }
  return v;
}
