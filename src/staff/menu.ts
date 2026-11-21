/**
 * The staff side menu's screens (M8 Task 3), in the board's order, with Users
 * after Moderation. Each task adds its own screen here. No imports beyond
 * types, so the browser can load it.
 */

export type StaffMenuGroup = "results" | "moderation" | "season" | "history";

/** The board's rows, which head the menu's groups. */
export const STAFF_MENU_GROUPS: Record<StaffMenuGroup, string> = {
  results: "Results and scoring",
  moderation: "Moderation",
  season: "Season data",
  history: "Settings and history",
};

export type StaffScreen = {
  id: string;
  label: string;
  href: string;
  group: StaffMenuGroup;
  /** The lowest role that may open it. */
  role: "moderator" | "admin";
};

export const STAFF_SCREENS: StaffScreen[] = [
  {
    id: "calendar",
    label: "Calendar",
    href: "/staff/calendar",
    group: "season",
    role: "admin",
  },
  {
    id: "seats",
    label: "Drivers and seats",
    href: "/staff/seats",
    group: "season",
    role: "admin",
  },
  {
    id: "audit",
    label: "Audit log",
    href: "/staff/audit",
    group: "history",
    role: "admin",
  },
];

export type StaffMenuItem = StaffScreen & {
  /** Waiting items (Tasks 10 and 11), when there are any. */
  count: number | null;
};

/**
 * The screens `role` may open, with their counts: a moderator gets the
 * moderator screens only, and an admin gets them all.
 */
export function staffMenu(
  role: "moderator" | "admin",
  counts: Record<string, number> = {},
  screens: StaffScreen[] = STAFF_SCREENS,
): StaffMenuItem[] {
  return screens
    .filter((s) => role === "admin" || s.role === "moderator")
    .map((s) => ({ ...s, count: counts[s.id] ? counts[s.id]! : null }));
}
