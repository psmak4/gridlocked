import {
  createFileRoute,
  Outlet,
  redirect,
  useLocation,
} from "@tanstack/react-router";
import { StaffShell } from "@/components/staff/staff-shell";
import { privateHeaders } from "@/lib/private-headers";
import { markPrivate } from "@/server/account";
import { getStaffArea } from "@/server/staff";
import { staffAreaRedirect } from "@/staff/area-redirect";
import { STAFF_SCREENS, staffMenu } from "@/staff/menu";

/**
 * The staff area (M8): wave 5's side menu around every staff screen. A
 * locked staff session goes to the security page to unlock, and anyone else
 * home. This guard is for the screen; each staff server function checks the
 * session again for itself.
 */
export const Route = createFileRoute("/staff")({
  beforeLoad: async () => {
    const staff = await getStaffArea();
    const to = staffAreaRedirect(staff);
    if (to !== null || staff.state !== "open") {
      // A redirect that depends on the cookie (route headers don't run).
      await markPrivate();
      throw redirect({ to: to ?? "/" });
    }
    return { staff };
  },
  head: () => ({ meta: [{ title: "Staff · Gridlocked" }] }),
  headers: privateHeaders,
  component: StaffLayout,
});

function StaffLayout() {
  const { staff } = Route.useRouteContext();
  const { pathname } = useLocation();
  const current =
    STAFF_SCREENS.find(
      (s) => pathname === s.href || pathname.startsWith(`${s.href}/`),
    )?.id ?? "";
  return (
    <StaffShell
      menu={staffMenu(staff.role, staff.counts)}
      current={current}
      who={{ username: staff.username, role: staff.role }}
    >
      <Outlet />
    </StaffShell>
  );
}
