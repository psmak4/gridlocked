/**
 * The staff layout's guard (M8 Task 3): who is in the staff area, and where
 * anyone else goes. No imports, so the layout's `beforeLoad`, which ships in
 * the browser's main bundle, carries no database code (`staffArea` in
 * `./area` reads the viewer, on the server).
 */

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
