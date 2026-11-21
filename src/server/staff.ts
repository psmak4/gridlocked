/**
 * The staff screens' server functions (M8). Each one is a `createServerFn`
 * whose handler is `staffFn`, so it runs `requireStaff` at its role before
 * its input is parsed, and answers `{ ok, value | error }`. The work is in
 * `src/staff/`, tested on a database without the Start runtime. Every task
 * adds its own functions here.
 */
import { createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import { staffArea, type StaffArea } from "@/staff/area";
import { getViewer } from "./session";

/**
 * Who is in the staff area, for the layout's guard and the menu. Not a
 * `staffFn`: a locked session gets an answer too, so the guard can send it
 * to the security page rather than show an error.
 */
export const getStaffArea = createServerFn({ method: "GET" }).handler(
  async (): Promise<StaffArea> => {
    setResponseHeader("Cache-Control", "private, no-store");
    return staffArea(await getViewer(getRequest()));
  },
);
